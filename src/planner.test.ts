import { describe, expect, it } from 'vitest';
import source from '../manifest.json';
import type { Api, DefinitionDto, RuleBindingDto } from './api';
import {
  bindingIdentity,
  canonicalJson,
  validateManifest,
  type Binding,
} from './manifest';
import { preflight, provision } from './planner';

const manifest = validateManifest(source);

function bindingResource(binding: Binding, index: number): RuleBindingDto {
  return {
    ...binding,
    id: `binding-${index}`,
    workspaceId: 'workspace',
    revision: 1,
  };
}

function publishedDefinition(bindings: RuleBindingDto[]): DefinitionDto {
  return {
    id: 'definition-1',
    workspaceId: 'workspace',
    name: manifest.businessObject.name,
    objectKey: manifest.businessObject.objectKey,
    status: 'Published',
    revision: 3,
    latestPublishedVersionNumber: 1,
    latestPublishedVersion: {
      versionNumber: 1,
      fields: [...manifest.businessObject.fields]
        .sort((left, right) => left.order - right.order)
        .map((field) => ({
          fieldKey: field.fieldKey,
          label: field.label,
          fieldType: field.fieldType,
          order: field.order,
          rules: field.rules.map((definitionKey, order) => {
            const expected = manifest.bindings.find(
              (candidate) =>
                candidate.definitionKey === definitionKey &&
                candidate.targetId ===
                  `${manifest.businessObject.objectKey}.${field.fieldKey}`,
            );
            if (!expected) throw Error('Invalid test fixture.');
            const binding = bindings.find(
              (candidate) => bindingIdentity(candidate) === bindingIdentity(expected),
            );
            if (!binding) throw Error('Invalid test fixture.');
            return { bindingId: binding.id, bindingRevision: binding.revision, order };
          }),
          ...(field.choiceConfiguration
            ? { choiceConfiguration: field.choiceConfiguration }
            : {}),
        })),
    },
  };
}

type ClientOptions = {
  bindings?: RuleBindingDto[];
  definition?: DefinitionDto;
  duplicateIdentity?: string;
  missingDependency?: string;
  failCreateAt?: number;
};

function testClient(options: ClientOptions = {}) {
  const state = {
    bindings: [...(options.bindings ?? [])],
    definition: options.definition,
    bindingCreates: 0,
    definitionCreates: 0,
  };
  const client = {
    me: async () => ({ workspaceId: 'workspace' }),
    getRuleDefinition: async (definitionKey: string) => ({
      definitionKey,
      publishedVersions:
        options.missingDependency === definitionKey ? [] : [{ versionNumber: 1 }],
    }),
    listUsage: async (definitionKey: string, definitionVersion: number) => {
      const usages = state.bindings
        .filter(
          (binding) =>
            binding.definitionKey === definitionKey &&
            binding.definitionVersion === definitionVersion,
        )
        .map((binding) => ({
          bindingId: binding.id,
          definitionKey: binding.definitionKey,
          definitionVersion: binding.definitionVersion,
          targetType: binding.targetType,
          targetId: binding.targetId,
          useCaseOrTrigger: binding.useCaseOrTrigger,
        }));
      const duplicate = usages.find(
        (usage) =>
          [
            usage.definitionKey,
            usage.definitionVersion,
            usage.targetType,
            usage.targetId,
            usage.useCaseOrTrigger,
          ].join('\u0000') === options.duplicateIdentity,
      );
      return duplicate ? [...usages, { ...duplicate, bindingId: 'duplicate' }] : usages;
    },
    getBinding: async (id: string) => {
      const result = state.bindings.find((binding) => binding.id === id);
      if (!result) throw Error(`Missing test binding ${id}.`);
      return structuredClone(result);
    },
    listDefinitions: async () => ({
      items: state.definition
        ? [{ id: state.definition.id, objectKey: state.definition.objectKey }]
        : [],
    }),
    getDefinition: async (id: string) => {
      if (!state.definition || state.definition.id !== id) {
        throw Error(`Missing test definition ${id}.`);
      }
      return structuredClone(state.definition);
    },
    createBinding: async (binding: Binding) => {
      state.bindingCreates += 1;
      if (state.bindingCreates === options.failCreateAt) {
        throw Error('Injected binding failure.');
      }
      const created = bindingResource(binding, state.bindings.length);
      state.bindings.push(created);
      return structuredClone(created);
    },
    createDefinition: async (name: string) => {
      state.definitionCreates += 1;
      state.definition = {
        id: 'definition-1',
        workspaceId: 'workspace',
        name,
        objectKey: manifest.businessObject.objectKey,
        status: 'Unpublished',
        revision: 1,
        latestPublishedVersionNumber: null,
      };
      return structuredClone(state.definition);
    },
    saveDefinition: async (id: string) => {
      if (!state.definition || state.definition.id !== id) throw Error('Missing definition.');
      state.definition.revision = 2;
      return structuredClone(state.definition);
    },
    publishDefinition: async (id: string) => {
      if (!state.definition || state.definition.id !== id) throw Error('Missing definition.');
      state.definition = publishedDefinition(state.bindings);
      return structuredClone(state.definition);
    },
    createRecord: async () => {
      throw Error('not called');
    },
    saveRecord: async () => {
      throw Error('not called');
    },
    submitRecord: async () => {
      throw Error('not called');
    },
  } as Api;
  return { client, state };
}

describe('preflight', () => {
  it('makes a deterministic reuse plan from exact public read-back', async () => {
    const bindings = manifest.bindings.map(bindingResource);
    const { client } = testClient({ bindings, definition: publishedDefinition(bindings) });
    const first = await preflight(client, manifest);
    const second = await preflight(client, manifest);

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.workspace).toBe('workspace');
    expect(first.entries.every((entry) => entry.action === 'reuse')).toBe(true);
  });

  it('fails closed for duplicate public binding identities', async () => {
    const bindings = manifest.bindings.map(bindingResource);
    const duplicateIdentity = bindingIdentity(manifest.bindings[1]);
    const { client } = testClient({ bindings, duplicateIdentity });
    const plan = await preflight(client, manifest);

    expect(plan.entries.find((entry) => entry.identity === duplicateIdentity)).toMatchObject({
      action: 'conflict',
      reason: 'Multiple bindings match this semantic identity.',
    });
  });

  it('reports a missing exact dependency without mutation', async () => {
    const { client, state } = testClient({ missingDependency: 'field.required' });
    const plan = await preflight(client, manifest);

    expect(plan.entries.find((entry) => entry.identity.includes('field.required'))).toMatchObject({
      action: 'conflict',
    });
    expect(state.bindingCreates).toBe(0);
    expect(state.definitionCreates).toBe(0);
  });

  it('compares published attachment IDs and revisions, not only field labels', async () => {
    const bindings = manifest.bindings.map(bindingResource);
    const definition = publishedDefinition(bindings);
    definition.latestPublishedVersion!.fields[0].rules[0].bindingRevision += 1;
    const { client } = testClient({ bindings, definition });
    const plan = await preflight(client, manifest);

    expect(plan.entries.at(-1)).toMatchObject({
      kind: 'definition',
      action: 'conflict',
      reason: 'Business Object definition differs from manifest.',
    });
  });
});

describe('provision', () => {
  it('creates a blank target, verifies read-back, and reapplies as a no-op', async () => {
    const { client, state } = testClient();
    const firstPlan = await preflight(client, manifest);
    const first = await provision(client, manifest, firstPlan, () => undefined);

    expect(first.pending).toEqual([]);
    expect(first.completed).toHaveLength(manifest.bindings.length + 1);
    expect(state.bindingCreates).toBe(manifest.bindings.length);
    expect(state.definitionCreates).toBe(1);

    const secondPlan = await preflight(client, manifest);
    const second = await provision(client, manifest, secondPlan, () => undefined);
    expect(second.pending).toEqual([]);
    expect(state.bindingCreates).toBe(manifest.bindings.length);
    expect(state.definitionCreates).toBe(1);
  });

  it('reports exact progress and resumes only from a fresh matching preflight', async () => {
    const { client, state } = testClient({ failCreateAt: 2 });
    const plan = await preflight(client, manifest);
    const failure = await provision(client, manifest, plan, () => undefined).catch(
      (error: Error & { completed: string[]; pending: string[] }) => error,
    );

    expect(failure.completed).toHaveLength(1);
    expect(failure.pending).toHaveLength(manifest.bindings.length);
    expect(state.bindings).toHaveLength(1);

    const resumePlan = await preflight(client, manifest);
    const resumed = await provision(client, manifest, resumePlan, () => undefined);
    expect(resumed.pending).toEqual([]);
    expect(state.bindings).toHaveLength(manifest.bindings.length);
  });

  it('rejects a changed target state before the next mutation', async () => {
    const { client, state } = testClient();
    const stalePlan = await preflight(client, manifest);
    state.bindings.push(bindingResource(manifest.bindings[0], 0));

    await expect(provision(client, manifest, stalePlan, () => undefined)).rejects.toThrow(
      'Target state changed after preflight',
    );
    expect(state.bindingCreates).toBe(0);
    expect(state.definitionCreates).toBe(0);
  });
});
