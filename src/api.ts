import {
  createBusinessObjectDefinition,
  createBusinessObjectRecord,
  createRuleBinding,
  getBusinessObjectDefinition,
  getMe,
  getRuleBinding,
  getRuleDefinition,
  listBusinessObjectDefinitions,
  listRuleBindingUsage,
  publishBusinessObjectDefinition,
  saveBusinessObjectRecord,
  saveUnpublishedBusinessObjectDefinition,
  submitBusinessObjectRecord,
} from './api-generated';
import { createClient } from './api-generated/client';
import type {
  BusinessObjectDefinitionDetailDto as GeneratedDefinitionDto,
  BusinessObjectDefinitionVersionChoiceFieldConfigurationDto as GeneratedVersionChoiceConfiguration,
  BusinessObjectRecordDetailDto as GeneratedRecordDto,
  BusinessObjectRecordSubmitResultDto as GeneratedSubmitResultDto,
  ProblemDetails,
  RuleBindingDto as GeneratedRuleBindingDto,
  RuleBindingUsageDto as GeneratedRuleBindingUsageDto,
  RuleDefinitionDetailDto as GeneratedRuleDefinitionDto,
  RuleInputMappingDto,
} from './api-generated/types.gen';
import type {
  Binding,
  ChoiceConfiguration,
  Field,
  FieldType,
  Mapping,
} from './manifest';

export type RuleBindingDto = Binding & {
  id: string;
  workspaceId: string;
  revision: number;
};
export type RuleBindingUsageDto = {
  bindingId: string;
  definitionKey: string;
  definitionVersion: number;
  targetType: string;
  targetId: string;
  useCaseOrTrigger: string;
};
export type DefinitionFieldDto = Omit<Field, 'rules'> & {
  rules: Array<{ bindingId: string; bindingRevision: number; order: number }>;
};
export type DefinitionDto = {
  id: string;
  workspaceId: string;
  name: string;
  objectKey: string;
  status: 'Unpublished' | 'Published';
  revision: number;
  latestPublishedVersionNumber: number | null;
  latestPublishedVersion?: { versionNumber: number; fields: DefinitionFieldDto[] };
};
export type DefinitionListItemDto = Pick<DefinitionDto, 'id' | 'objectKey'>;
export type RecordDto = {
  id: string;
  revision: number;
  status: 'Draft' | 'Submitted';
  values: Record<string, string[]>;
};
export type RuleDefinitionDto = {
  definitionKey: string;
  publishedVersions: Array<{ versionNumber: number }>;
};
export type SaveDefinitionInput = {
  expectedRevision: number;
  name: string;
  fields: Array<{
    fieldKey: string;
    label: string;
    fieldType: FieldType;
    rules: Array<{ bindingId: string }>;
    choiceConfiguration?: ChoiceConfiguration;
  }>;
};
export type Api = ReturnType<typeof api>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type GeneratedResult<T> = {
  data: T | undefined;
  error?: unknown;
  response?: Response;
};

function problemDetail(error: unknown, status: number): string {
  const problem = error as ProblemDetails | undefined;
  return typeof problem?.detail === 'string' && problem.detail.length > 0
    ? problem.detail
    : `Request failed (${status})`;
}

function unwrap<T>(result: GeneratedResult<T>): T {
  if (result.data !== undefined) return result.data;
  const status = result.response?.status ?? 0;
  throw new ApiError(status, problemDetail(result.error, status));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw Error(`Axis response is missing ${path}.`);
  }
  return value;
}

function requiredInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw Error(`Axis response is missing ${path}.`);
  return value as number;
}

function mapping(value: RuleInputMappingDto | undefined, path: string): Mapping {
  if (
    value?.kind === 'Context' &&
    typeof value.contextKey === 'string' &&
    Array.isArray(value.literalValues) &&
    value.literalValues.length === 0
  ) {
    return { kind: 'Context', contextKey: value.contextKey, literalValues: [] };
  }
  if (
    value?.kind === 'Literal' &&
    value.contextKey === null &&
    Array.isArray(value.literalValues) &&
    value.literalValues.length > 0 &&
    value.literalValues.every((literal) => typeof literal === 'string')
  ) {
    return {
      kind: 'Literal',
      contextKey: null,
      literalValues: value.literalValues as [string, ...string[]],
    };
  }
  throw Error(`Axis response has invalid ${path}.`);
}

function ruleBinding(value: GeneratedRuleBindingDto): RuleBindingDto {
  if (
    value.targetType !== 'business-object-field' ||
    value.useCaseOrTrigger !== 'field-validation' ||
    (value.failureBehavior !== 'FailClosed' && value.failureBehavior !== 'FailOpen') ||
    typeof value.enabled !== 'boolean' ||
    !value.inputMappings
  ) {
    throw Error('Axis response has an incompatible Rule Binding contract.');
  }
  return {
    id: requiredString(value.id, 'Rule Binding id'),
    workspaceId: requiredString(value.workspaceId, 'Rule Binding workspaceId'),
    definitionKey: requiredString(value.definitionKey, 'Rule Binding definitionKey'),
    definitionVersion: requiredInteger(
      value.definitionVersion,
      'Rule Binding definitionVersion',
    ),
    targetType: value.targetType,
    targetId: requiredString(value.targetId, 'Rule Binding targetId'),
    useCaseOrTrigger: value.useCaseOrTrigger,
    inputMappings: Object.fromEntries(
      Object.entries(value.inputMappings).map(([name, inputMapping]) => [
        name,
        mapping(inputMapping, `Rule Binding inputMappings.${name}`),
      ]),
    ),
    priority: requiredInteger(value.priority, 'Rule Binding priority'),
    enabled: value.enabled,
    failureBehavior: value.failureBehavior,
    revision: requiredInteger(value.revision, 'Rule Binding revision'),
  };
}

function ruleBindingUsage(value: GeneratedRuleBindingUsageDto): RuleBindingUsageDto {
  return {
    bindingId: requiredString(value.bindingId, 'Rule Binding usage bindingId'),
    definitionKey: requiredString(value.definitionKey, 'Rule Binding usage definitionKey'),
    definitionVersion: requiredInteger(
      value.definitionVersion,
      'Rule Binding usage definitionVersion',
    ),
    targetType: requiredString(value.targetType, 'Rule Binding usage targetType'),
    targetId: requiredString(value.targetId, 'Rule Binding usage targetId'),
    useCaseOrTrigger: requiredString(
      value.useCaseOrTrigger,
      'Rule Binding usage useCaseOrTrigger',
    ),
  };
}

function versionChoiceConfiguration(
  value: GeneratedVersionChoiceConfiguration | undefined,
  path: string,
): ChoiceConfiguration | undefined {
  if (!value) return undefined;
  if (
    (value.selectionMode !== 'Single' && value.selectionMode !== 'Multiple') ||
    !Array.isArray(value.options)
  ) {
    throw Error(`Axis response has invalid ${path}.`);
  }
  return {
    selectionMode: value.selectionMode,
    options: value.options.map((option, index) => ({
      optionKey: requiredString(option.optionKey, `${path}.options[${index}].optionKey`),
      label: requiredString(option.label, `${path}.options[${index}].label`),
      order: requiredInteger(option.order, `${path}.options[${index}].order`),
    })),
  };
}

function definition(value: GeneratedDefinitionDto): DefinitionDto {
  if (value.status !== 'Unpublished' && value.status !== 'Published') {
    throw Error('Axis response has an incompatible Business Object status.');
  }
  const latestPublishedVersion = value.latestPublishedVersion
    ? {
        versionNumber: requiredInteger(
          value.latestPublishedVersion.versionNumber,
          'Business Object published version number',
        ),
        fields: (value.latestPublishedVersion.fields ?? []).map((field, fieldIndex) => {
          const fieldType = field.fieldType;
          if (!fieldType) {
            throw Error(
              `Axis response is missing Business Object fields[${fieldIndex}].fieldType.`,
            );
          }
          const result: DefinitionFieldDto = {
            fieldKey: requiredString(
              field.fieldKey,
              `Business Object fields[${fieldIndex}].fieldKey`,
            ),
            label: requiredString(
              field.label,
              `Business Object fields[${fieldIndex}].label`,
            ),
            fieldType,
            order: requiredInteger(
              field.order,
              `Business Object fields[${fieldIndex}].order`,
            ),
            rules: (field.rules ?? []).map((rule, ruleIndex) => ({
              bindingId: requiredString(
                rule.bindingId,
                `Business Object fields[${fieldIndex}].rules[${ruleIndex}].bindingId`,
              ),
              bindingRevision: requiredInteger(
                rule.bindingRevision,
                `Business Object fields[${fieldIndex}].rules[${ruleIndex}].bindingRevision`,
              ),
              order: requiredInteger(
                rule.order,
                `Business Object fields[${fieldIndex}].rules[${ruleIndex}].order`,
              ),
            })),
          };
          const choiceConfiguration = versionChoiceConfiguration(
            field.choiceConfiguration,
            `Business Object fields[${fieldIndex}].choiceConfiguration`,
          );
          if (choiceConfiguration) result.choiceConfiguration = choiceConfiguration;
          return result;
        }),
      }
    : undefined;
  return {
    id: requiredString(value.id, 'Business Object id'),
    workspaceId: requiredString(value.workspaceId, 'Business Object workspaceId'),
    name: requiredString(value.name, 'Business Object name'),
    objectKey: requiredString(value.objectKey, 'Business Object objectKey'),
    status: value.status,
    revision: requiredInteger(value.revision, 'Business Object revision'),
    latestPublishedVersionNumber:
      value.latestPublishedVersionNumber === null
        ? null
        : requiredInteger(
            value.latestPublishedVersionNumber,
            'Business Object latestPublishedVersionNumber',
          ),
    ...(latestPublishedVersion ? { latestPublishedVersion } : {}),
  };
}

function record(value: GeneratedRecordDto): RecordDto {
  return {
    id: requiredString(value.id, 'record id'),
    revision: requiredInteger(value.revision, 'record revision'),
    status: value.status,
    values: value.values,
  };
}

function ruleDefinition(value: GeneratedRuleDefinitionDto): RuleDefinitionDto {
  return {
    definitionKey: requiredString(value.definitionKey, 'Rule definition key'),
    publishedVersions: (value.versions ?? []).map((version, index) => ({
      versionNumber: requiredInteger(version.version, `Rule versions[${index}].version`),
    })),
  };
}

export function api(csrfToken: () => string | null) {
  const client = createClient({
    baseUrl: '',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      if (!['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(request.method.toUpperCase())) {
        const token = csrfToken();
        if (!token) throw Error('The browser session has no CSRF token.');
        headers.set('X-CSRF-TOKEN', token);
      }
      return fetch(new Request(request, { headers, credentials: 'same-origin' }));
    },
  });
  return {
    me: async () => {
      const result = unwrap(await getMe({ client }));
      return { workspaceId: result.workspaceId ?? undefined };
    },
    listDefinitions: async () => {
      const result = unwrap(
        await listBusinessObjectDefinitions({
          client,
          query: { page: 1, pageSize: 100, language: 'en' },
        }),
      );
      return {
        items: result.items.map((item, index) => ({
          id: requiredString(item.id, `Business Object list items[${index}].id`),
          objectKey: requiredString(
            item.objectKey,
            `Business Object list items[${index}].objectKey`,
          ),
        })),
      };
    },
    getDefinition: async (id: string) =>
      definition(unwrap(await getBusinessObjectDefinition({ client, path: { id } }))),
    createDefinition: async (name: string) =>
      definition(unwrap(await createBusinessObjectDefinition({ client, body: { name } }))),
    saveDefinition: async (id: string, body: SaveDefinitionInput) =>
      definition(
        unwrap(
          await saveUnpublishedBusinessObjectDefinition({
            client,
            path: { id },
            body: {
              expectedRevision: body.expectedRevision,
              name: body.name,
              fields: body.fields.map((field) => ({
                fieldKey: field.fieldKey,
                label: field.label,
                fieldType: field.fieldType,
                rules: field.rules,
                ...(field.choiceConfiguration
                  ? {
                      choiceConfiguration: {
                        selectionMode: field.choiceConfiguration.selectionMode,
                        options: field.choiceConfiguration.options.map((option) => ({
                          optionKey: option.optionKey,
                          label: option.label,
                        })),
                      },
                    }
                  : {}),
              })),
            },
          }),
        ),
      ),
    publishDefinition: async (id: string, expectedRevision: number) =>
      definition(
        unwrap(
          await publishBusinessObjectDefinition({
            client,
            path: { id },
            body: { expectedRevision },
          }),
        ),
      ),
    getRuleDefinition: async (definitionKey: string) =>
      ruleDefinition(
        unwrap(await getRuleDefinition({ client, path: { definitionKey } })),
      ),
    listUsage: async (definitionKey: string, definitionVersion: number) =>
      unwrap(
        await listRuleBindingUsage({
          client,
          path: { definitionKey },
          query: { version: definitionVersion },
        }),
      ).map(ruleBindingUsage),
    getBinding: async (bindingId: string) =>
      ruleBinding(unwrap(await getRuleBinding({ client, path: { bindingId } }))),
    createBinding: async (binding: Binding) =>
      ruleBinding(unwrap(await createRuleBinding({ client, body: binding }))),
    createRecord: async (objectKey: string, values: Record<string, string[]>) =>
      record(
        unwrap(
          await createBusinessObjectRecord({
            client,
            path: { objectKey },
            body: { idempotencyKey: crypto.randomUUID(), values },
          }),
        ),
      ),
    saveRecord: async (
      recordId: string,
      expectedRevision: number,
      values: Record<string, string[]>,
    ) =>
      record(
        unwrap(
          await saveBusinessObjectRecord({
            client,
            path: { recordId },
            body: { expectedRevision, values },
          }),
        ),
      ),
    submitRecord: async (recordId: string, expectedRevision: number) => {
      const result: GeneratedSubmitResultDto = unwrap(
        await submitBusinessObjectRecord({
          client,
          path: { recordId },
          body: { expectedRevision },
        }),
      );
      return { isSubmitted: result.isSubmitted, record: record(result.record) };
    },
  };
}
