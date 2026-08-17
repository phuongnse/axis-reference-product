import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify as verifySignature,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const solutionPayloadType = 'application/vnd.axis.solution.v1+json';
const defaultProductRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256Pattern = /^[0-9a-f]{64}$/;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const solutionVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const componentSources = Object.freeze([
  {
    type: 'authorization.policy.v1',
    key: 'reference_application',
    file: 'authorization-policy.json',
    property: 'policy',
    dependsOn: [],
  },
  {
    type: 'business-object.definition.v1',
    key: 'loan_application',
    file: 'business-object-definition.json',
    property: 'businessObject',
    dependsOn: [
      {
        type: 'rule.binding.v1',
        key: 'field.numeric_range@1:business-object-field:loan_application.requested_amount:field-validation',
      },
      {
        type: 'rule.binding.v1',
        key: 'field.required@1:business-object-field:loan_application.applicant_name:field-validation',
      },
      {
        type: 'rule.binding.v1',
        key: 'field.text_format@1:business-object-field:loan_application.contact_email:field-validation',
      },
    ],
  },
  {
    type: 'rule.binding.v1',
    key: 'field.numeric_range@1:business-object-field:loan_application.requested_amount:field-validation',
    file: 'rule-numeric-range.json',
    property: 'numericRangeRule',
    dependsOn: [],
  },
  {
    type: 'rule.binding.v1',
    key: 'field.required@1:business-object-field:loan_application.applicant_name:field-validation',
    file: 'rule-required.json',
    property: 'requiredRule',
    dependsOn: [],
  },
  {
    type: 'rule.binding.v1',
    key: 'field.text_format@1:business-object-field:loan_application.contact_email:field-validation',
    file: 'rule-text-format.json',
    property: 'textFormatRule',
    dependsOn: [],
  },
]);

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, path) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${path} must be an object.`);
  assert(
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys),
    `${path} has an incompatible property contract.`,
  );
}

function assert(condition, message) {
  if (!condition) throw Error(message);
}

function inspectCanonical(value, path) {
  assert(value !== null, `${path} cannot be null.`);
  if (typeof value === 'string') {
    assert(value === value.trim(), `${path} must be trimmed.`);
    assert(value === value.normalize('NFC'), `${path} must use NFC.`);
    return;
  }
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), `${path} must be a safe integer.`);
    return;
  }
  if (typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectCanonical(entry, `${path}[${index}]`));
    return;
  }
  assert(typeof value === 'object', `${path} has an unsupported JSON value.`);
  for (const [key, entry] of Object.entries(value)) {
    inspectCanonical(key, `${path} property`);
    inspectCanonical(entry, `${path}.${key}`);
  }
}

function encodeString(value) {
  let encoded = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x08: encoded += '\\b'; break;
      case 0x09: encoded += '\\t'; break;
      case 0x0a: encoded += '\\n'; break;
      case 0x0c: encoded += '\\f'; break;
      case 0x0d: encoded += '\\r'; break;
      case 0x22: encoded += '\\"'; break;
      case 0x5c: encoded += '\\\\'; break;
      default:
        if (code <= 0x1f) {
          encoded += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
        } else if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            encoded += value[index] + value[index + 1];
            index += 1;
          } else {
            encoded += `\\u${code.toString(16).padStart(4, '0')}`;
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          encoded += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          encoded += value[index];
        }
    }
  }
  return `${encoded}"`;
}

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'Canonical JSON numbers must be finite.');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  assert(typeof value === 'object', 'Canonical JSON contains an unsupported value.');
  return `{${Object.entries(value)
    .map(([key, entry]) => `${encodeString(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

async function readCanonicalJson(path) {
  const raw = await readFile(path, 'utf8');
  assert(!raw.startsWith('\uFEFF'), `${path} cannot contain a BOM.`);
  assert(!raw.includes('\r'), `${path} must use LF line endings.`);
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  assert(!text.includes('\n'), `${path} must contain one canonical JSON value.`);
  const parsed = JSON.parse(text);
  inspectCanonical(parsed, path);
  assert(canonicalJson(parsed) === text, `${path} is not canonical JSON.`);
  return parsed;
}

export async function loadSolutionSource({ productRoot = defaultProductRoot } = {}) {
  const solutionRoot = resolve(productRoot, 'solution');
  const release = await readCanonicalJson(resolve(solutionRoot, 'release.json'));
  exactKeys(release, ['schemaVersion', 'solutionKey', 'solutionVersion', 'publisher', 'provenance'], 'release');
  exactKeys(release.publisher, ['publisherId', 'publisherKeyId'], 'release.publisher');
  exactKeys(release.provenance, ['buildId', 'builtAt', 'sourceUri'], 'release.provenance');
  assert(release.schemaVersion === 1, 'release.schemaVersion must be 1.');
  assert(
    solutionVersionPattern.test(release.solutionVersion),
    'release.solutionVersion must be a stable major.minor.patch version.',
  );
  assert(
    release.provenance.buildId === `reference-product-${release.solutionVersion}`,
    'release.provenance.buildId must match release.solutionVersion.',
  );

  const source = { release };
  for (const component of componentSources) {
    source[component.property] = await readCanonicalJson(resolve(solutionRoot, component.file));
  }
  return source;
}

export function developmentSolutionVersion(stableVersion, sourceRevision) {
  assert(
    solutionVersionPattern.test(stableVersion ?? ''),
    'A stable major.minor.patch base version is required for a development snapshot.',
  );
  assert(
    revisionPattern.test(sourceRevision ?? ''),
    'A lower-case 40 or 64 hex source revision is required for a development snapshot.',
  );
  return `${stableVersion}-dev.g${sourceRevision.slice(0, 12)}`;
}

function sha256(bytes) {
  const value = createHash('sha256').update(bytes).digest('hex');
  assert(sha256Pattern.test(value), 'SHA-256 output was not canonical.');
  return value;
}

function pae(payloadBytes) {
  const typeBytes = Buffer.from(solutionPayloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, 'ascii'),
    typeBytes,
    Buffer.from(` ${payloadBytes.length} `, 'ascii'),
    payloadBytes,
  ]);
}

function signingKey(value) {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  assert(key.type === 'private', 'The solution signing key must be private.');
  assert(key.asymmetricKeyType === 'ec', 'The solution signing key must be EC.');
  assert(
    key.asymmetricKeyDetails?.namedCurve === 'prime256v1',
    'The solution signing key must use P-256.',
  );
  return key;
}

export async function buildSolutionPackage({
  development = false,
  privateKey,
  sourceRevision,
  productRoot = defaultProductRoot,
} = {}) {
  assert(revisionPattern.test(sourceRevision ?? ''), 'A lower-case 40 or 64 hex source revision is required.');
  const source = await loadSolutionSource({ productRoot });
  const openApiBytes = await readFile(resolve(productRoot, 'openapi.json'));

  const components = componentSources.map((descriptor) => {
    const contentBytes = Buffer.from(canonicalJson(source[descriptor.property]), 'utf8');
    return {
      type: descriptor.type,
      key: descriptor.key,
      sha256: sha256(contentBytes),
      content: contentBytes.toString('base64url'),
      dependsOn: descriptor.dependsOn,
      contentBytes,
    };
  });
  const sorted = [...components].sort(
    (left, right) => ordinal(left.type, right.type) || ordinal(left.key, right.key),
  );
  assert(
    components.every((component, index) => component === sorted[index]),
    'Solution components must be in canonical type/key order.',
  );

  const { release } = source;
  const solutionVersion = development
    ? developmentSolutionVersion(release.solutionVersion, sourceRevision)
    : release.solutionVersion;
  const payload = {
    schemaVersion: 1,
    solutionKey: release.solutionKey,
    solutionVersion,
    axisOpenApiSha256: sha256(openApiBytes),
    publisher: {
      publisherId: release.publisher.publisherId,
      publisherKeyId: release.publisher.publisherKeyId,
    },
    provenance: {
      sourceRevision,
      buildId: development
        ? `reference-product-${solutionVersion}`
        : release.provenance.buildId,
      builtAt: release.provenance.builtAt,
      sourceUri: release.provenance.sourceUri,
    },
    components: components.map(({ contentBytes: _, ...component }) => component),
  };
  const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
  const paeBytes = pae(payloadBytes);
  const signature = sign('sha256', paeBytes, {
    key: signingKey(privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  assert(signature.length === 64, 'The ES256 signature must be 64-byte P1363.');
  const envelope = {
    payloadType: solutionPayloadType,
    payload: payloadBytes.toString('base64url'),
    signatures: [{ keyid: release.publisher.publisherKeyId, sig: signature.toString('base64url') }],
  };
  return {
    components,
    envelope,
    envelopeBytes: Buffer.from(JSON.stringify(envelope), 'utf8'),
    paeBytes,
    payload,
    payloadBytes,
  };
}

export function verifySolutionEnvelope(existingBytes, publicKey) {
  const existing = JSON.parse(existingBytes.toString('utf8'));
  exactKeys(existing, ['payloadType', 'payload', 'signatures'], 'solution envelope');
  assert(existing.payloadType === solutionPayloadType, 'The solution envelope payload type is invalid.');
  assert(typeof existing.payload === 'string', 'The solution envelope payload is invalid.');
  assert(existing.signatures.length === 1, 'The solution envelope must contain one signature.');
  const [signature] = existing.signatures;
  exactKeys(signature, ['keyid', 'sig'], 'solution envelope signature');
  assert(typeof signature.keyid === 'string', 'The solution envelope key id is invalid.');
  assert(typeof signature.sig === 'string', 'The solution envelope signature is invalid.');

  const payloadBytes = Buffer.from(existing.payload, 'base64url');
  assert(
    payloadBytes.toString('base64url') === existing.payload,
    'The solution envelope payload encoding is not canonical.',
  );
  const payloadText = payloadBytes.toString('utf8');
  const payload = JSON.parse(payloadText);
  inspectCanonical(payload, 'solution payload');
  assert(canonicalJson(payload) === payloadText, 'The solution envelope payload is not canonical.');
  assert(
    signature.keyid === payload.publisher?.publisherKeyId,
    'The solution envelope key id does not match the payload publisher key id.',
  );

  const signatureBytes = Buffer.from(signature.sig, 'base64url');
  assert(
    signatureBytes.toString('base64url') === signature.sig && signatureBytes.length === 64,
    'The solution envelope signature encoding is invalid.',
  );
  assert(
    verifySignature(
      'sha256',
      pae(payloadBytes),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signatureBytes,
    ),
    'The solution envelope signature is invalid.',
  );
  return { envelope: existing, payload, payloadBytes };
}

export function isReusableSolutionEnvelope(existingBytes, built, publicKey) {
  try {
    const verified = verifySolutionEnvelope(existingBytes, publicKey);
    return (
      verified.envelope.payload === built.payloadBytes.toString('base64url') &&
      verified.envelope.signatures[0].keyid === built.payload.publisher.publisherKeyId
    );
  } catch {
    return false;
  }
}

export async function writeImmutableSolutionArtifact(outputPath, built, publicKey) {
  if (!existsSync(outputPath)) {
    await writeFile(outputPath, built.envelopeBytes);
    return;
  }
  if (isReusableSolutionEnvelope(await readFile(outputPath), built, publicKey)) return;
  throw Error(
    `Refusing to replace immutable solution artifact ${outputPath}. ` +
      'A stable release requires a new intentional solutionVersion; a development snapshot requires a new committed source revision. ' +
      'If the signing key or artifact changed unexpectedly, restore the original release files; a version bump or database reset cannot repair publisher-key identity.',
  );
}

async function main() {
  const keyPath = process.env.AXIS_SOLUTION_SIGNING_KEY_FILE;
  const sourceRevision = process.env.AXIS_SOLUTION_SOURCE_REVISION;
  assert(keyPath, 'AXIS_SOLUTION_SIGNING_KEY_FILE is required.');
  const privateKey = await readFile(resolve(keyPath), 'utf8');
  const built = await buildSolutionPackage({ privateKey, sourceRevision });
  const outputPath = resolve(
    process.env.AXIS_SOLUTION_OUTPUT ??
      resolve(defaultProductRoot, '.axis-solution', `${built.payload.solutionKey}-${built.payload.solutionVersion}.dsse.json`),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeImmutableSolutionArtifact(outputPath, built, createPublicKey(privateKey));
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
