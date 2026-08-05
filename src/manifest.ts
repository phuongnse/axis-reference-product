export const fieldTypes = [
  'Text',
  'Integer',
  'Decimal',
  'Date',
  'DateTime',
  'Boolean',
  'Choice',
] as const;

export type FieldType = (typeof fieldTypes)[number];
export type Mapping =
  | { kind: 'Context'; contextKey: string; literalValues: [] }
  | { kind: 'Literal'; contextKey: null; literalValues: [string, ...string[]] };
export type Binding = {
  definitionKey: string;
  definitionVersion: number;
  targetType: 'business-object-field';
  targetId: string;
  useCaseOrTrigger: 'field-validation';
  inputMappings: Record<string, Mapping>;
  priority: number;
  enabled: boolean;
  failureBehavior: 'FailClosed' | 'FailOpen';
};
export type ChoiceOption = { optionKey: string; label: string; order: number };
export type ChoiceConfiguration = {
  selectionMode: 'Single' | 'Multiple';
  options: ChoiceOption[];
};
export type Field = {
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  order: number;
  rules: string[];
  choiceConfiguration?: ChoiceConfiguration;
};
export type Manifest = {
  manifestVersion: 1;
  solutionKey: string;
  solutionVersion: string;
  axisOpenApiSha256: string;
  content: { locale: string; applicationTitle: string };
  bindings: Binding[];
  businessObject: { name: string; objectKey: string; fields: Field[] };
};

const semanticKey = /^[a-z][a-z0-9_]*$/;
const ruleKey = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const sha256 = /^[a-f0-9]{64}$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = object(value, path);
  for (const name of required) {
    if (!(name in result)) throw Error(`${path}.${name} is required`);
  }
  const permitted = new Set([...required, ...optional]);
  for (const name of Object.keys(result)) {
    if (!permitted.has(name)) throw Error(`${path}.${name} is unknown`);
  }
  return result;
}

function normalizedText(value: unknown, path: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value !== value.normalize('NFC') ||
    (!allowEmpty && value.length === 0)
  ) {
    throw Error(`${path} must be a non-empty trimmed NFC string`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw Error(`${path} must be an integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const result = integer(value, path);
  if (result < 0) throw Error(`${path} must be non-negative`);
  return result;
}

const ordinal = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => ordinal(left, right))
      .map(([name, child]) => [name, canonical(child)]),
  );
}

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonical(value));

const identity = (binding: Binding) =>
  [
    binding.definitionKey,
    binding.definitionVersion,
    binding.targetType,
    binding.targetId,
    binding.useCaseOrTrigger,
  ].join('\u0000');

function validateMapping(value: unknown, path: string): Mapping {
  const source = exact(value, path, ['kind', 'contextKey', 'literalValues']);
  if (!Array.isArray(source.literalValues)) {
    throw Error(`${path}.literalValues must be an array`);
  }
  const literalValues = source.literalValues.map((literal, index) =>
    normalizedText(literal, `${path}.literalValues[${index}]`, true),
  );
  if (source.kind === 'Context') {
    const contextKey = normalizedText(source.contextKey, `${path}.contextKey`);
    if (literalValues.length !== 0) {
      throw Error(`${path} context mapping cannot have literal values`);
    }
    return { kind: 'Context', contextKey, literalValues: [] };
  }
  if (source.kind === 'Literal' && source.contextKey === null && literalValues.length > 0) {
    return {
      kind: 'Literal',
      contextKey: null,
      literalValues: literalValues as [string, ...string[]],
    };
  }
  throw Error(`${path} is invalid`);
}

function validateBinding(value: unknown, index: number): Binding {
  const path = `manifest.bindings[${index}]`;
  const source = exact(value, path, [
    'definitionKey',
    'definitionVersion',
    'targetType',
    'targetId',
    'useCaseOrTrigger',
    'inputMappings',
    'priority',
    'enabled',
    'failureBehavior',
  ]);
  const definitionKey = normalizedText(source.definitionKey, `${path}.definitionKey`);
  if (!ruleKey.test(definitionKey)) throw Error(`${path}.definitionKey is invalid`);
  const definitionVersion = integer(source.definitionVersion, `${path}.definitionVersion`);
  if (definitionVersion < 1) throw Error(`${path}.definitionVersion must be positive`);
  if (source.targetType !== 'business-object-field') {
    throw Error(`${path}.targetType is unsupported`);
  }
  if (source.useCaseOrTrigger !== 'field-validation') {
    throw Error(`${path}.useCaseOrTrigger is unsupported`);
  }
  const targetId = normalizedText(source.targetId, `${path}.targetId`);
  const priority = nonNegativeInteger(source.priority, `${path}.priority`);
  if (typeof source.enabled !== 'boolean') throw Error(`${path}.enabled must be boolean`);
  if (source.failureBehavior !== 'FailClosed' && source.failureBehavior !== 'FailOpen') {
    throw Error(`${path}.failureBehavior is invalid`);
  }
  const mappingsSource = object(source.inputMappings, `${path}.inputMappings`);
  if (Object.keys(mappingsSource).length === 0) {
    throw Error(`${path}.inputMappings must not be empty`);
  }
  const inputMappings: Record<string, Mapping> = {};
  for (const [name, mapping] of Object.entries(mappingsSource)) {
    if (!semanticKey.test(name)) throw Error(`${path}.inputMappings.${name} is invalid`);
    inputMappings[name] = validateMapping(mapping, `${path}.inputMappings.${name}`);
  }
  return {
    definitionKey,
    definitionVersion,
    targetType: 'business-object-field',
    targetId,
    useCaseOrTrigger: 'field-validation',
    inputMappings,
    priority,
    enabled: source.enabled,
    failureBehavior: source.failureBehavior,
  };
}

function validateChoiceConfiguration(value: unknown, path: string): ChoiceConfiguration {
  const source = exact(value, path, ['selectionMode', 'options']);
  if (source.selectionMode !== 'Single' && source.selectionMode !== 'Multiple') {
    throw Error(`${path}.selectionMode is invalid`);
  }
  if (!Array.isArray(source.options) || source.options.length === 0) {
    throw Error(`${path}.options must be a non-empty array`);
  }
  const optionKeys = new Set<string>();
  const optionOrders = new Set<number>();
  const options = source.options.map((value, index): ChoiceOption => {
    const optionPath = `${path}.options[${index}]`;
    const option = exact(value, optionPath, ['optionKey', 'label', 'order']);
    const optionKey = normalizedText(option.optionKey, `${optionPath}.optionKey`);
    if (!semanticKey.test(optionKey)) throw Error(`${optionPath}.optionKey is invalid`);
    const label = normalizedText(option.label, `${optionPath}.label`);
    const order = nonNegativeInteger(option.order, `${optionPath}.order`);
    if (optionKeys.has(optionKey)) throw Error(`${optionPath}.optionKey is duplicated`);
    if (optionOrders.has(order)) throw Error(`${optionPath}.order is duplicated`);
    optionKeys.add(optionKey);
    optionOrders.add(order);
    return { optionKey, label, order };
  });
  const sortedOrders = [...optionOrders].sort((left, right) => left - right);
  if (sortedOrders.some((order, index) => order !== index)) {
    throw Error(`${path}.options orders must be contiguous from zero`);
  }
  return { selectionMode: source.selectionMode, options };
}

function validateField(value: unknown, index: number): Field {
  const path = `manifest.businessObject.fields[${index}]`;
  const source = exact(
    value,
    path,
    ['fieldKey', 'label', 'fieldType', 'order', 'rules'],
    ['choiceConfiguration'],
  );
  const fieldKey = normalizedText(source.fieldKey, `${path}.fieldKey`);
  if (!semanticKey.test(fieldKey)) throw Error(`${path}.fieldKey is invalid`);
  const label = normalizedText(source.label, `${path}.label`);
  if (!fieldTypes.includes(source.fieldType as FieldType)) {
    throw Error(`${path}.fieldType is unsupported`);
  }
  const fieldType = source.fieldType as FieldType;
  const order = nonNegativeInteger(source.order, `${path}.order`);
  if (!Array.isArray(source.rules)) throw Error(`${path}.rules must be an array`);
  const ruleKeys = new Set<string>();
  const rules = source.rules.map((rule, ruleIndex) => {
    const value = normalizedText(rule, `${path}.rules[${ruleIndex}]`);
    if (!ruleKey.test(value)) throw Error(`${path}.rules[${ruleIndex}] is invalid`);
    if (ruleKeys.has(value)) throw Error(`${path}.rules[${ruleIndex}] is duplicated`);
    ruleKeys.add(value);
    return value;
  });
  if (fieldType === 'Choice') {
    if (!('choiceConfiguration' in source)) {
      throw Error(`${path}.choiceConfiguration is required for Choice`);
    }
    return {
      fieldKey,
      label,
      fieldType,
      order,
      rules,
      choiceConfiguration: validateChoiceConfiguration(
        source.choiceConfiguration,
        `${path}.choiceConfiguration`,
      ),
    };
  }
  if ('choiceConfiguration' in source) {
    throw Error(`${path}.choiceConfiguration is only valid for Choice`);
  }
  return { fieldKey, label, fieldType, order, rules };
}

export function validateManifest(input: unknown): Manifest {
  const root = exact(input, 'manifest', [
    'manifestVersion',
    'solutionKey',
    'solutionVersion',
    'axisOpenApiSha256',
    'content',
    'bindings',
    'businessObject',
  ]);
  if (root.manifestVersion !== 1) throw Error('manifest.manifestVersion must be 1');

  const solutionKey = normalizedText(root.solutionKey, 'manifest.solutionKey');
  if (!semanticKey.test(solutionKey)) throw Error('manifest.solutionKey is invalid');
  const solutionVersion = normalizedText(root.solutionVersion, 'manifest.solutionVersion');
  if (!semver.test(solutionVersion)) {
    throw Error('manifest.solutionVersion is not exact SemVer');
  }
  const axisOpenApiSha256 = normalizedText(
    root.axisOpenApiSha256,
    'manifest.axisOpenApiSha256',
  );
  if (!sha256.test(axisOpenApiSha256)) {
    throw Error('manifest.axisOpenApiSha256 is invalid');
  }

  const contentSource = exact(root.content, 'manifest.content', [
    'locale',
    'applicationTitle',
  ]);
  const content = {
    locale: normalizedText(contentSource.locale, 'manifest.content.locale'),
    applicationTitle: normalizedText(
      contentSource.applicationTitle,
      'manifest.content.applicationTitle',
    ),
  };

  if (!Array.isArray(root.bindings)) throw Error('manifest.bindings must be an array');
  const bindings = root.bindings.map(validateBinding);
  const bindingIdentities = new Set<string>();
  for (const binding of bindings) {
    const bindingKey = identity(binding);
    if (bindingIdentities.has(bindingKey)) {
      throw Error(`binding ${binding.definitionKey} duplicates semantic identity`);
    }
    bindingIdentities.add(bindingKey);
  }

  const businessSource = exact(root.businessObject, 'manifest.businessObject', [
    'name',
    'objectKey',
    'fields',
  ]);
  const name = normalizedText(businessSource.name, 'manifest.businessObject.name');
  const objectKey = normalizedText(
    businessSource.objectKey,
    'manifest.businessObject.objectKey',
  );
  if (!semanticKey.test(objectKey)) throw Error('manifest.businessObject.objectKey is invalid');
  if (!Array.isArray(businessSource.fields) || businessSource.fields.length === 0) {
    throw Error('manifest.businessObject.fields must be a non-empty array');
  }
  const fields = businessSource.fields.map(validateField);
  const fieldKeys = new Set<string>();
  const fieldOrders = new Set<number>();
  for (const field of fields) {
    if (fieldKeys.has(field.fieldKey)) throw Error(`field ${field.fieldKey} duplicates key`);
    if (fieldOrders.has(field.order)) throw Error(`field ${field.fieldKey} duplicates order`);
    fieldKeys.add(field.fieldKey);
    fieldOrders.add(field.order);
  }
  const sortedFieldOrders = [...fieldOrders].sort((left, right) => left - right);
  if (sortedFieldOrders.some((order, index) => order !== index)) {
    throw Error('manifest.businessObject.fields orders must be contiguous from zero');
  }

  const attachedBindings = new Set<string>();
  for (const field of fields) {
    for (const definitionKey of field.rules) {
      const matches = bindings.filter(
        (binding) =>
          binding.definitionKey === definitionKey &&
          binding.targetId === `${objectKey}.${field.fieldKey}`,
      );
      if (matches.length !== 1) {
        throw Error(
          `field ${field.fieldKey} rule ${definitionKey} must have one matching binding`,
        );
      }
      attachedBindings.add(identity(matches[0]));
    }
  }
  for (const binding of bindings) {
    const expectedPrefix = `${objectKey}.`;
    const fieldKey = binding.targetId.startsWith(expectedPrefix)
      ? binding.targetId.slice(expectedPrefix.length)
      : '';
    if (!semanticKey.test(fieldKey) || !fieldKeys.has(fieldKey)) {
      throw Error(`binding ${binding.definitionKey} targets an unknown field`);
    }
    if (!attachedBindings.has(identity(binding))) {
      throw Error(`binding ${binding.definitionKey} is not attached to its target field`);
    }
  }

  return {
    manifestVersion: 1,
    solutionKey,
    solutionVersion,
    axisOpenApiSha256,
    content,
    bindings,
    businessObject: { name, objectKey, fields },
  };
}

export const bindingIdentity = identity;

export const manifestProjection = (manifest: Manifest) => ({
  manifestVersion: manifest.manifestVersion,
  solutionKey: manifest.solutionKey,
  solutionVersion: manifest.solutionVersion,
  axisOpenApiSha256: manifest.axisOpenApiSha256,
  content: manifest.content,
  bindings: [...manifest.bindings].sort((left, right) =>
    ordinal(identity(left), identity(right)),
  ),
  businessObject: {
    name: manifest.businessObject.name,
    objectKey: manifest.businessObject.objectKey,
    expectedPublishedVersion: 1,
    fields: [...manifest.businessObject.fields].sort((left, right) => left.order - right.order),
  },
});

export const canonicalManifestJson = (manifest: Manifest): string =>
  canonicalJson(manifestProjection(manifest));

export async function verifyOpenApiDigest(
  manifest: Manifest,
  openApi: ArrayBuffer,
): Promise<void> {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', openApi)),
  )
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== manifest.axisOpenApiSha256) {
    throw Error('Committed OpenAPI digest does not match manifest.');
  }
}
