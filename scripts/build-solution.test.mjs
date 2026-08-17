import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSolutionPackage,
  canonicalJson,
  loadSolutionSource,
  solutionPayloadType,
} from './build-solution.mjs';

const sourceRevision = '0123456789abcdef0123456789abcdef01234567';
const productRoot = fileURLToPath(new URL('..', import.meta.url));

test('builds deterministic canonical component and payload bytes with a valid DSSE signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { release } = await loadSolutionSource();
  const first = await buildSolutionPackage({ privateKey, sourceRevision });
  const second = await buildSolutionPackage({ privateKey, sourceRevision });

  assert.deepEqual(first.payloadBytes, second.payloadBytes);
  assert.deepEqual(
    first.components.map((component) => component.contentBytes),
    second.components.map((component) => component.contentBytes),
  );
  assert.equal(first.payload.schemaVersion, 1);
  assert.equal(first.payload.solutionKey, release.solutionKey);
  assert.equal(first.payload.solutionVersion, release.solutionVersion);
  assert.equal(
    first.payload.axisOpenApiSha256,
    createHash('sha256')
      .update(await readFile(join(productRoot, 'openapi.json')))
      .digest('hex'),
  );
  assert.equal(first.components.length, 5);
  assert.deepEqual(
    first.components.map(({ type, key }) => [type, key]),
    [...first.components]
      .sort((left, right) => left.type.localeCompare(right.type) || left.key.localeCompare(right.key))
      .map(({ type, key }) => [type, key]),
  );

  const envelope = JSON.parse(first.envelopeBytes.toString('utf8'));
  assert.equal(envelope.payloadType, solutionPayloadType);
  assert.deepEqual(Buffer.from(envelope.payload, 'base64url'), first.payloadBytes);
  assert.equal(envelope.signatures.length, 1);
  assert.equal(envelope.signatures[0].keyid, 'release');
  assert.equal(Buffer.from(envelope.signatures[0].sig, 'base64url').length, 64);
  assert.equal(
    verify(
      'sha256',
      first.paeBytes,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(envelope.signatures[0].sig, 'base64url'),
    ),
    true,
  );
});

test('keeps source component documents canonical and reference roles exact', async () => {
  const source = await loadSolutionSource();
  assert.deepEqual(source.policy.roles.map((role) => role.key), [
    'Administrator',
    'Applicant',
    'Caseworker',
  ]);
  assert.deepEqual(
    source.policy.grants
      .filter((grant) => grant.roleKey === 'Administrator')
      .map((grant) => [grant.actionKey, grant.scope]),
    [
      ['business-object.definition.read-published', 'None'],
      ['business-object.record.list', 'All'],
      ['business-object.record.read', 'All'],
    ],
  );
  assert.deepEqual(
    source.policy.grants
      .filter((grant) => grant.roleKey === 'Applicant')
      .map((grant) => [grant.actionKey, grant.scope]),
    [
      ['business-object.definition.read-published', 'None'],
      ['business-object.record.create', 'Own'],
      ['business-object.record.read', 'Own'],
      ['business-object.record.save', 'Own'],
      ['business-object.record.submit', 'Own'],
    ],
  );
  assert.deepEqual(
    source.policy.grants
      .filter((grant) => grant.roleKey === 'Caseworker')
      .map((grant) => [grant.actionKey, grant.scope]),
    [
      ['business-object.definition.read-published', 'None'],
      ['business-object.record.list', 'All'],
      ['business-object.record.read', 'All'],
    ],
  );
  assert.equal(source.businessObject.objectKey, 'loan_application');
  assert.deepEqual(
    source.businessObject.fields.map((field) => field.fieldKey),
    ['applicant_name', 'contact_email', 'requested_amount', 'purpose'],
  );
});

test('enforces V-002 control-character escapes in source, component, and payload bytes', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'axis-reference-product-canonical-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await cp(join(productRoot, 'solution'), join(temporaryRoot, 'solution'), { recursive: true });
  await cp(join(productRoot, 'openapi.json'), join(temporaryRoot, 'openapi.json'));

  const releasePath = join(temporaryRoot, 'solution', 'release.json');
  const policyPath = join(temporaryRoot, 'solution', 'authorization-policy.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  release.provenance.sourceUri = 'https://example.test/reference\u000Bbuild\nline';
  policy.roles[0].presentation.en.description = 'Admin\u000Brole';
  const canonicalRelease = canonicalJson(release);
  await writeFile(releasePath, canonicalRelease, 'utf8');
  await writeFile(policyPath, canonicalJson(policy), 'utf8');

  assert.match(canonicalRelease, /reference\\u000Bbuild\\nline/);
  assert.equal(
    (await loadSolutionSource({ productRoot: temporaryRoot })).release.provenance.sourceUri,
    'https://example.test/reference\u000Bbuild\nline',
  );

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const built = await buildSolutionPackage({ privateKey, sourceRevision, productRoot: temporaryRoot });
  assert.match(built.payloadBytes.toString('utf8'), /reference\\u000Bbuild\\nline/);
  assert.match(
    built.components.find((component) => component.type === 'authorization.policy.v1').contentBytes.toString('utf8'),
    /Admin\\u000Brole/,
  );

  await writeFile(releasePath, canonicalRelease.replace('\\u000B', '\\u000b'), 'utf8');
  await assert.rejects(() => loadSolutionSource({ productRoot: temporaryRoot }), /not canonical JSON/);

  await writeFile(releasePath, canonicalRelease.replace('\\n', '\\u000A'), 'utf8');
  await assert.rejects(() => loadSolutionSource({ productRoot: temporaryRoot }), /not canonical JSON/);
});

test('requires the release build identity to match its canonical solution version', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'axis-reference-product-version-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await cp(join(productRoot, 'solution'), join(temporaryRoot, 'solution'), { recursive: true });
  await cp(join(productRoot, 'openapi.json'), join(temporaryRoot, 'openapi.json'));

  const releasePath = join(temporaryRoot, 'solution', 'release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.provenance.buildId = 'reference-product-0.1.0';
  await writeFile(releasePath, canonicalJson(release), 'utf8');
  await assert.rejects(
    () => loadSolutionSource({ productRoot: temporaryRoot }),
    /buildId must match release\.solutionVersion/,
  );

  release.solutionVersion = '01.2.3';
  release.provenance.buildId = 'reference-product-01.2.3';
  await writeFile(releasePath, canonicalJson(release), 'utf8');
  await assert.rejects(
    () => loadSolutionSource({ productRoot: temporaryRoot }),
    /stable major\.minor\.patch version/,
  );
});
