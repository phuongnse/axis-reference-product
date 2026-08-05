import { ApiError, type Api, type DefinitionDto, type RuleBindingDto } from './api';
import {
  bindingIdentity,
  canonicalJson,
  type Binding,
  type Field,
  type Manifest,
} from './manifest';

export type PlanEntry = {
  kind: 'binding' | 'definition';
  identity: string;
  action: 'create' | 'reuse' | 'conflict';
  reason: string;
  resource?: RuleBindingDto | DefinitionDto;
};
export type Plan = { workspace: string; entries: PlanEntry[] };
export type ProvisionResult = {
  completed: string[];
  pending: string[];
  definition?: DefinitionDto;
};

const ordinal = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const bindingProjection = (binding: RuleBindingDto): Binding => ({
  definitionKey: binding.definitionKey,
  definitionVersion: binding.definitionVersion,
  targetType: binding.targetType,
  targetId: binding.targetId,
  useCaseOrTrigger: binding.useCaseOrTrigger,
  inputMappings: binding.inputMappings,
  priority: binding.priority,
  enabled: binding.enabled,
  failureBehavior: binding.failureBehavior,
});

export const sameBinding = (expected: Binding, actual: RuleBindingDto): boolean =>
  canonicalJson(expected) === canonicalJson(bindingProjection(actual));

function usageIdentity(usage: {
  definitionKey: string;
  definitionVersion: number;
  targetType: string;
  targetId: string;
  useCaseOrTrigger: string;
}): string {
  return [
    usage.definitionKey,
    usage.definitionVersion,
    usage.targetType,
    usage.targetId,
    usage.useCaseOrTrigger,
  ].join('\u0000');
}

function bindingResources(entries: PlanEntry[]): Map<string, RuleBindingDto> {
  return new Map(
    entries.flatMap((entry): Array<[string, RuleBindingDto]> =>
      entry.kind === 'binding' &&
      entry.resource !== undefined &&
      'definitionKey' in entry.resource
        ? [[entry.identity, entry.resource]]
        : [],
    ),
  );
}

function expectedDefinitionFields(
  manifest: Manifest,
  bindings: Map<string, RuleBindingDto>,
): DefinitionDto['latestPublishedVersion'] extends infer _Version
  ? Array<{
      fieldKey: string;
      label: string;
      fieldType: Field['fieldType'];
      order: number;
      rules: Array<{ bindingId: string; bindingRevision: number; order: number }>;
      choiceConfiguration?: Field['choiceConfiguration'];
    }>
  : never {
  return [...manifest.businessObject.fields]
    .sort((left, right) => left.order - right.order)
    .map((field) => {
      const expected = {
        fieldKey: field.fieldKey,
        label: field.label,
        fieldType: field.fieldType,
        order: field.order,
        rules: field.rules.map((definitionKey, order) => {
          const binding = manifest.bindings.find(
            (candidate) =>
              candidate.definitionKey === definitionKey &&
              candidate.targetId ===
                `${manifest.businessObject.objectKey}.${field.fieldKey}`,
          );
          if (!binding) throw Error(`Missing binding for ${field.fieldKey}.${definitionKey}.`);
          const resource = bindings.get(bindingIdentity(binding));
          if (!resource) {
            throw Error(`Binding read-back is missing for ${field.fieldKey}.${definitionKey}.`);
          }
          return {
            bindingId: resource.id,
            bindingRevision: resource.revision,
            order,
          };
        }),
        ...(field.choiceConfiguration
          ? {
              choiceConfiguration: {
                selectionMode: field.choiceConfiguration.selectionMode,
                options: [...field.choiceConfiguration.options].sort(
                  (left, right) => left.order - right.order,
                ),
              },
            }
          : {}),
      };
      return expected;
    });
}

export function sameDefinition(
  manifest: Manifest,
  current: DefinitionDto,
  bindings: Map<string, RuleBindingDto>,
): boolean {
  const version = current.latestPublishedVersion;
  if (
    current.name !== manifest.businessObject.name ||
    current.objectKey !== manifest.businessObject.objectKey ||
    current.status !== 'Published' ||
    current.latestPublishedVersionNumber !== 1 ||
    !version ||
    version.versionNumber !== 1
  ) {
    return false;
  }
  try {
    const actual = [...version.fields]
      .sort((left, right) => left.order - right.order)
      .map((field) => ({
        fieldKey: field.fieldKey,
        label: field.label,
        fieldType: field.fieldType,
        order: field.order,
        rules: [...field.rules]
          .sort((left, right) => left.order - right.order)
          .map((rule) => ({
            bindingId: rule.bindingId,
            bindingRevision: rule.bindingRevision,
            order: rule.order,
          })),
        ...(field.choiceConfiguration
          ? {
              choiceConfiguration: {
                selectionMode: field.choiceConfiguration.selectionMode,
                options: [...field.choiceConfiguration.options].sort(
                  (left, right) => left.order - right.order,
                ),
              },
            }
          : {}),
      }));
    return canonicalJson(actual) === canonicalJson(expectedDefinitionFields(manifest, bindings));
  } catch {
    return false;
  }
}

async function dependencyExists(
  client: Api,
  binding: Binding,
): Promise<boolean> {
  try {
    const dependency = await client.getRuleDefinition(binding.definitionKey);
    return (
      dependency.definitionKey === binding.definitionKey &&
      dependency.publishedVersions.some(
        (version) => version.versionNumber === binding.definitionVersion,
      )
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

export async function preflight(client: Api, manifest: Manifest): Promise<Plan> {
  const user = await client.me();
  if (!user.workspaceId) throw Error('Current workspace is unavailable.');
  const entries: PlanEntry[] = [];

  for (const binding of [...manifest.bindings].sort((left, right) =>
    ordinal(bindingIdentity(left), bindingIdentity(right)),
  )) {
    const identity = bindingIdentity(binding);
    if (!(await dependencyExists(client, binding))) {
      entries.push({
        kind: 'binding',
        identity,
        action: 'conflict',
        reason: `Required built-in rule ${binding.definitionKey}@${binding.definitionVersion} is unavailable.`,
      });
      continue;
    }
    const usages = await client.listUsage(
      binding.definitionKey,
      binding.definitionVersion,
    );
    const matches = usages.filter((usage) => usageIdentity(usage) === identity);
    if (matches.length > 1) {
      entries.push({
        kind: 'binding',
        identity,
        action: 'conflict',
        reason: 'Multiple bindings match this semantic identity.',
      });
      continue;
    }
    if (matches.length === 0) {
      entries.push({
        kind: 'binding',
        identity,
        action: 'create',
        reason: 'No matching binding exists.',
      });
      continue;
    }
    const current = await client.getBinding(matches[0].bindingId);
    const exact = current.workspaceId === user.workspaceId && sameBinding(binding, current);
    entries.push({
      kind: 'binding',
      identity,
      action: exact ? 'reuse' : 'conflict',
      reason: exact
        ? 'Existing binding exactly matches manifest.'
        : 'Existing binding differs from manifest.',
      resource: current,
    });
  }

  const definitions = await client.listDefinitions();
  const matches = definitions.items.filter(
    (definition) => definition.objectKey === manifest.businessObject.objectKey,
  );
  if (matches.length > 1) {
    entries.push({
      kind: 'definition',
      identity: manifest.businessObject.objectKey,
      action: 'conflict',
      reason: 'Multiple Business Object definitions use this object key.',
    });
  } else if (matches.length === 0) {
    entries.push({
      kind: 'definition',
      identity: manifest.businessObject.objectKey,
      action: 'create',
      reason: 'No matching Business Object definition exists.',
    });
  } else {
    const current = await client.getDefinition(matches[0].id);
    const exact =
      current.workspaceId === user.workspaceId &&
      sameDefinition(manifest, current, bindingResources(entries));
    entries.push({
      kind: 'definition',
      identity: manifest.businessObject.objectKey,
      action: exact ? 'reuse' : 'conflict',
      reason: exact
        ? 'Published definition exactly matches manifest.'
        : 'Business Object definition differs from manifest.',
      resource: current,
    });
  }
  return { workspace: user.workspaceId, entries };
}

function stablePlanProjection(plan: Plan) {
  return {
    workspace: plan.workspace,
    entries: plan.entries.map(({ kind, identity, action }) => ({ kind, identity, action })),
  };
}

function removePending(pending: string[], identity: string): void {
  const index = pending.indexOf(identity);
  if (index >= 0) pending.splice(index, 1);
}

function saveFields(manifest: Manifest, bindings: Map<string, RuleBindingDto>) {
  return [...manifest.businessObject.fields]
    .sort((left, right) => left.order - right.order)
    .map((field) => ({
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      rules: field.rules.map((definitionKey) => {
        const binding = manifest.bindings.find(
          (candidate) =>
            candidate.definitionKey === definitionKey &&
            candidate.targetId === `${manifest.businessObject.objectKey}.${field.fieldKey}`,
        );
        if (!binding) throw Error(`Missing binding for ${field.fieldKey}.${definitionKey}.`);
        const resource = bindings.get(bindingIdentity(binding));
        if (!resource) {
          throw Error(`Binding read-back is missing for ${field.fieldKey}.${definitionKey}.`);
        }
        return { bindingId: resource.id };
      }),
      ...(field.choiceConfiguration
        ? {
            choiceConfiguration: {
              selectionMode: field.choiceConfiguration.selectionMode,
              options: [...field.choiceConfiguration.options].sort(
                (left, right) => left.order - right.order,
              ),
            },
          }
        : {}),
    }));
}

export async function provision(
  client: Api,
  manifest: Manifest,
  confirmedPlan: Plan,
  onProgress: (entry: string) => void,
): Promise<ProvisionResult> {
  if (confirmedPlan.entries.some((entry) => entry.action === 'conflict')) {
    throw Error('Resolve preflight conflicts before provisioning.');
  }
  const freshPlan = await preflight(client, manifest);
  if (
    canonicalJson(stablePlanProjection(freshPlan)) !==
    canonicalJson(stablePlanProjection(confirmedPlan))
  ) {
    throw Error('Target state changed after preflight. Run preflight again.');
  }

  const completed: string[] = [];
  const pending = freshPlan.entries.map((entry) => entry.identity);
  const bindings = new Map<string, RuleBindingDto>();
  try {
    for (const binding of [...manifest.bindings].sort((left, right) =>
      ordinal(bindingIdentity(left), bindingIdentity(right)),
    )) {
      const identity = bindingIdentity(binding);
      const entry = freshPlan.entries.find(
        (candidate) => candidate.kind === 'binding' && candidate.identity === identity,
      );
      if (!entry) throw Error(`Preflight entry is missing for ${identity}.`);
      onProgress(identity);
      const writeResult =
        entry.action === 'reuse' &&
        entry.resource !== undefined &&
        'definitionKey' in entry.resource
          ? entry.resource
          : await client.createBinding(binding);
      const readBack = await client.getBinding(writeResult.id);
      if (readBack.workspaceId !== freshPlan.workspace || !sameBinding(binding, readBack)) {
        throw Error(`Read-back mismatch for ${identity}.`);
      }
      bindings.set(identity, readBack);
      completed.push(identity);
      removePending(pending, identity);
    }

    const definitionEntry = freshPlan.entries.find(
      (entry) => entry.kind === 'definition',
    );
    if (!definitionEntry) throw Error('Business Object preflight entry is missing.');
    onProgress(manifest.businessObject.objectKey);
    if (
      definitionEntry.action === 'reuse' &&
      definitionEntry.resource !== undefined &&
      'objectKey' in definitionEntry.resource
    ) {
      const readBack = await client.getDefinition(definitionEntry.resource.id);
      if (
        readBack.workspaceId !== freshPlan.workspace ||
        !sameDefinition(manifest, readBack, bindings)
      ) {
        throw Error('Read-back mismatch for Business Object definition.');
      }
      completed.push(definitionEntry.identity);
      removePending(pending, definitionEntry.identity);
      return { completed, pending, definition: readBack };
    }

    let definition = await client.createDefinition(manifest.businessObject.name);
    if (
      definition.workspaceId !== freshPlan.workspace ||
      definition.objectKey !== manifest.businessObject.objectKey ||
      definition.status !== 'Unpublished'
    ) {
      throw Error('Created Business Object identity does not match manifest.');
    }
    definition = await client.saveDefinition(definition.id, {
      expectedRevision: definition.revision,
      name: manifest.businessObject.name,
      fields: saveFields(manifest, bindings),
    });
    definition = await client.publishDefinition(definition.id, definition.revision);
    const readBack = await client.getDefinition(definition.id);
    if (
      readBack.workspaceId !== freshPlan.workspace ||
      !sameDefinition(manifest, readBack, bindings)
    ) {
      throw Error('Read-back mismatch for Business Object definition.');
    }
    completed.push(manifest.businessObject.objectKey);
    removePending(pending, manifest.businessObject.objectKey);
    return { completed, pending, definition: readBack };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provisioning failed.';
    throw Object.assign(new Error(message), { completed, pending });
  }
}
