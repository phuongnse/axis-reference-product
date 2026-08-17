import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertAxisOpenApiCompatibility,
  buildAxisInvocation,
  prepareLocalDevInvocation,
  prepareSolutionRelease,
  prepareTopologyRecoveryInvocation,
  resolveReferenceProductUid,
} from './local-dev.mjs';

const sourceRevision = '0123456789abcdef0123456789abcdef01234567';

test('prepares one ignored signed release and reuses its private key', async (t) => {
  const outputRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-release-'),
  );
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const first = await prepareSolutionRelease({ outputRoot, sourceRevision });
  const firstPackage = await readFile(first.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE);
  const second = await prepareSolutionRelease({ outputRoot, sourceRevision });

  assert.equal(
    first.AXIS_REFERENCE_PRODUCT_PUBLISHER_PUBLIC_KEY,
    second.AXIS_REFERENCE_PRODUCT_PUBLISHER_PUBLIC_KEY,
  );
  assert.match(first.AXIS_REFERENCE_PRODUCT_PUBLISHER_PUBLIC_KEY, /BEGIN PUBLIC KEY/);
  assert.deepEqual(
    await readFile(second.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE),
    firstPackage,
  );
  assert.equal(
    JSON.parse(await readFile(first.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE, 'utf8')).payloadType,
    'application/vnd.axis.solution.v1+json',
  );
  assert.equal((await stat(join(outputRoot, 'release-key.pem'))).mode & 0o777, 0o600);
});

test('preserves an immutable artifact when payload bytes change at the same version', async (t) => {
  const outputRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-release-'),
  );
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const first = await prepareSolutionRelease({ outputRoot, sourceRevision });
  const firstPackage = await readFile(first.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE);
  await assert.rejects(
    () =>
      prepareSolutionRelease({
        outputRoot,
        sourceRevision: '1123456789abcdef0123456789abcdef01234567',
      }),
    /Refusing to replace immutable solution artifact.*Bump .*solutionVersion/s,
  );
  assert.deepEqual(
    await readFile(first.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE),
    firstPackage,
  );
});

test('refuses silent signing-key replacement when immutable artifacts already exist', async (t) => {
  const outputRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-release-'),
  );
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await writeFile(join(outputRoot, 'reference_application-0.1.1.dsse.json'), '{}');

  await assert.rejects(
    () => prepareSolutionRelease({ outputRoot, sourceRevision }),
    /signing key is missing.*Restore .*release-key\.pem.*do not.*reset the database/s,
  );
  await assert.rejects(() => stat(join(outputRoot, 'release-key.pem')), { code: 'ENOENT' });
});

test('creates a separate artifact after the canonical release version is bumped', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-version-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const currentProductRoot = join(temporaryRoot, 'product');
  const outputRoot = join(temporaryRoot, 'output');
  await mkdir(currentProductRoot, { recursive: true });
  await cp(join(process.cwd(), 'solution'), join(currentProductRoot, 'solution'), {
    recursive: true,
  });
  await cp(join(process.cwd(), 'openapi.json'), join(currentProductRoot, 'openapi.json'));

  const first = await prepareSolutionRelease({
    outputRoot,
    productRoot: currentProductRoot,
    sourceRevision,
  });
  const releasePath = join(currentProductRoot, 'solution', 'release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const [major, minor, patch] = release.solutionVersion.split('.').map(Number);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  release.solutionVersion = nextVersion;
  release.provenance.buildId = `reference-product-${nextVersion}`;
  await writeFile(releasePath, JSON.stringify(release), 'utf8');
  const second = await prepareSolutionRelease({
    outputRoot,
    productRoot: currentProductRoot,
    sourceRevision,
  });
  assert.notEqual(
    second.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE,
    first.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE,
  );
  assert.ok(
    second.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE.endsWith(`-${nextVersion}.dsse.json`),
  );
  await stat(first.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE);
  await stat(second.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE);
});

test('rejects an Axis/product OpenAPI mismatch before preparing local release state', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-preflight-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const currentProductRoot = join(temporaryRoot, 'product');
  const outputRoot = join(temporaryRoot, 'release-output');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(axisRoot, 'src', 'Axis.Api'), { recursive: true });
  await mkdir(join(currentProductRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(join(currentProductRoot, 'deploy', 'local.compose.yml'), 'services: {}\n');
  await writeFile(join(axisRoot, 'openapi.json'), '{"axis":true}\n');
  await writeFile(join(currentProductRoot, 'openapi.json'), '{"product":true}\n');
  const axisDigest = '195d7963703df1ac11803dd55ae7a6457791186051527618ea3e554df253276a';
  await writeFile(
    join(axisRoot, 'src', 'Axis.Api', 'appsettings.json'),
    JSON.stringify({ Solutions: { AxisOpenApiSha256: axisDigest } }),
  );

  await assert.rejects(
    () =>
      prepareLocalDevInvocation('up', axisRoot, {
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
        sourceRevision,
      }),
    /Reference-product OpenAPI is incompatible.*bump the immutable solution release version/s,
  );
  await assert.rejects(() => stat(outputRoot), { code: 'ENOENT' });
});

test('accepts an exact Axis OpenAPI/configuration/product digest', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-preflight-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const currentProductRoot = join(temporaryRoot, 'product');
  await mkdir(join(axisRoot, 'src', 'Axis.Api'), { recursive: true });
  await mkdir(currentProductRoot, { recursive: true });
  const openApi = '{"openapi":"3.1.0"}\n';
  await writeFile(join(axisRoot, 'openapi.json'), openApi);
  await writeFile(join(currentProductRoot, 'openapi.json'), openApi);
  const digest = '7927cf5b451b44fb947646f0e189a8b41ed29b043923cf030c42d00da8a3b072';
  await writeFile(
    join(axisRoot, 'src', 'Axis.Api', 'appsettings.json'),
    JSON.stringify({ Solutions: { AxisOpenApiSha256: digest } }),
  );

  assert.equal(await assertAxisOpenApiCompatibility(axisRoot, currentProductRoot), digest);
});

test('passive commands never initialize missing release state', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-passive-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const outputRoot = join(temporaryRoot, 'missing-release');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');

  await assert.rejects(
    () =>
      prepareLocalDevInvocation('status', axisRoot, {
        currentProductRoot: process.cwd(),
        getuid: () => 1000,
        outputRoot,
      }),
    /signing key is missing.*passive local-dev commands.*no replacement key was generated/s,
  );
  await assert.rejects(() => stat(outputRoot), { code: 'ENOENT' });
});

test('recorded product topology requires restoring missing release state', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-bound-release-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const currentProductRoot = join(temporaryRoot, 'product');
  const outputRoot = join(temporaryRoot, 'missing-release');
  const overlay = join(currentProductRoot, 'deploy', 'local.compose.yml');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(axisRoot, 'src', 'Axis.Api'), { recursive: true });
  await mkdir(join(axisRoot, '.local'), { recursive: true });
  await mkdir(join(currentProductRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(overlay, 'services: {}\n');
  const openApi = '{"openapi":"3.1.0"}\n';
  await writeFile(join(axisRoot, 'openapi.json'), openApi);
  await writeFile(join(currentProductRoot, 'openapi.json'), openApi);
  const digest = '7927cf5b451b44fb947646f0e189a8b41ed29b043923cf030c42d00da8a3b072';
  await writeFile(
    join(axisRoot, 'src', 'Axis.Api', 'appsettings.json'),
    JSON.stringify({ Solutions: { AxisOpenApiSha256: digest } }),
  );
  await writeFile(
    join(axisRoot, '.local', 'local-dev-topology.json'),
    JSON.stringify({ version: 1, composeOverlays: [overlay] }),
  );

  await assert.rejects(
    () =>
      prepareLocalDevInvocation('up', axisRoot, {
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
        sourceRevision,
      }),
    /signing key is missing.*Restore .*release-key\.pem.*do not.*reset the database/s,
  );
  await assert.rejects(() => stat(outputRoot), { code: 'ENOENT' });

  await mkdir(outputRoot, { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(
    join(outputRoot, 'release-key.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  await cp(join(process.cwd(), 'solution'), join(currentProductRoot, 'solution'), {
    recursive: true,
  });
  await assert.rejects(
    () =>
      prepareLocalDevInvocation('up', axisRoot, {
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
        sourceRevision,
      }),
    /immutable solution artifact is missing.*Restore that exact artifact.*do not.*reset the database/s,
  );
  await assert.rejects(
    () => stat(join(outputRoot, 'reference_application-0.1.6.dsse.json')),
    { code: 'ENOENT' },
  );
});

test('Axis evidence reuses the verified deployed release without rebuilding it from current HEAD', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-axis-e2e-release-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const currentProductRoot = join(temporaryRoot, 'product');
  const outputRoot = join(temporaryRoot, 'release-output');
  const overlay = join(currentProductRoot, 'deploy', 'local.compose.yml');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(axisRoot, 'src', 'Axis.Api'), { recursive: true });
  await mkdir(join(axisRoot, '.local'), { recursive: true });
  await mkdir(join(currentProductRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(overlay, 'services: {}\n');
  const openApi = '{"openapi":"3.1.0"}\n';
  await writeFile(join(axisRoot, 'openapi.json'), openApi);
  await writeFile(join(currentProductRoot, 'openapi.json'), openApi);
  const digest = '7927cf5b451b44fb947646f0e189a8b41ed29b043923cf030c42d00da8a3b072';
  await writeFile(
    join(axisRoot, 'src', 'Axis.Api', 'appsettings.json'),
    JSON.stringify({ Solutions: { AxisOpenApiSha256: digest } }),
  );
  await cp(join(process.cwd(), 'solution'), join(currentProductRoot, 'solution'), {
    recursive: true,
  });

  const release = await prepareSolutionRelease({
    outputRoot,
    productRoot: currentProductRoot,
    sourceRevision,
  });
  const keyBefore = await readFile(join(outputRoot, 'release-key.pem'));
  const artifactBefore = await readFile(release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE);
  await writeFile(
    join(axisRoot, '.local', 'local-dev-topology.json'),
    JSON.stringify({ version: 1, composeOverlays: [overlay] }),
  );

  const invocation = await prepareLocalDevInvocation('axis-e2e', axisRoot, {
    currentProductRoot,
    getuid: () => 1000,
    outputRoot,
    sourceRevision: '1123456789abcdef0123456789abcdef01234567',
    additionalArguments: ['--', 'e2e/app-frame.pw.ts', '-g', 'AT-002'],
  });

  assert.equal(
    invocation.environment.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE,
    release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE,
  );
  assert.deepEqual(await readFile(join(outputRoot, 'release-key.pem')), keyBefore);
  assert.deepEqual(
    await readFile(release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE),
    artifactBefore,
  );

  const invalidEnvelope = JSON.parse(artifactBefore.toString('utf8'));
  invalidEnvelope.signatures[0].sig = `${invalidEnvelope.signatures[0].sig.slice(0, -1)}${
    invalidEnvelope.signatures[0].sig.endsWith('A') ? 'B' : 'A'
  }`;
  await writeFile(
    release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE,
    JSON.stringify(invalidEnvelope),
  );
  await assert.rejects(
    () =>
      prepareLocalDevInvocation('axis-e2e', axisRoot, {
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
        additionalArguments: ['--', 'e2e/app-frame.pw.ts'],
      }),
    /failed signature or canonical-envelope verification/,
  );
  await writeFile(release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE, artifactBefore);

  const mismatchedKeyEnvelope = JSON.parse(artifactBefore.toString('utf8'));
  mismatchedKeyEnvelope.signatures[0].keyid = 'modified-key-id';
  await writeFile(
    release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE,
    JSON.stringify(mismatchedKeyEnvelope),
  );
  await assert.rejects(
    () =>
      prepareLocalDevInvocation('axis-e2e', axisRoot, {
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
        additionalArguments: ['--', 'e2e/app-frame.pw.ts'],
      }),
    /failed signature or canonical-envelope verification/,
  );
  await writeFile(release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE, artifactBefore);

  const nextOpenApi = '{"openapi":"3.1.1"}\n';
  const nextDigest = createHash('sha256').update(nextOpenApi).digest('hex');
  await writeFile(join(axisRoot, 'openapi.json'), nextOpenApi);
  await writeFile(join(currentProductRoot, 'openapi.json'), nextOpenApi);
  await writeFile(
    join(axisRoot, 'src', 'Axis.Api', 'appsettings.json'),
    JSON.stringify({ Solutions: { AxisOpenApiSha256: nextDigest } }),
  );
  await assert.rejects(
    () =>
      prepareLocalDevInvocation('axis-e2e', axisRoot, {
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
        additionalArguments: ['--', 'e2e/app-frame.pw.ts'],
      }),
    /existing immutable solution artifact targets Axis OpenAPI.*recorded deployment requires/s,
  );
});

test('topology recovery accepts an absent or exactly matching marker', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-recovery-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const currentProductRoot = join(temporaryRoot, 'product');
  const outputRoot = join(temporaryRoot, 'release-output');
  const overlay = join(currentProductRoot, 'deploy', 'local.compose.yml');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(axisRoot, '.local'), { recursive: true });
  await mkdir(join(currentProductRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(join(axisRoot, 'openapi.json'), '{"axis":true}\n');
  await writeFile(join(currentProductRoot, 'openapi.json'), '{"product":true}\n');
  await writeFile(overlay, 'services: {}\n');
  await cp(join(process.cwd(), 'solution'), join(currentProductRoot, 'solution'), {
    recursive: true,
  });
  const release = await prepareSolutionRelease({
    outputRoot,
    productRoot: currentProductRoot,
    sourceRevision,
  });
  const keyBefore = await readFile(join(outputRoot, 'release-key.pem'));
  const artifactBefore = await readFile(release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE);

  const invocation = await prepareTopologyRecoveryInvocation(axisRoot, {
    confirmation: '--yes',
    currentProductRoot,
    getuid: () => 1000,
    outputRoot,
  });
  await writeFile(
    join(axisRoot, '.local', 'local-dev-topology.json'),
    JSON.stringify({ version: 1, composeOverlays: [overlay] }),
  );
  const matchingInvocation = await prepareTopologyRecoveryInvocation(axisRoot, {
    confirmation: '--yes',
    currentProductRoot,
    getuid: () => 1000,
    outputRoot,
  });

  assert.equal(invocation.executable, 'python');
  assert.deepEqual(invocation.arguments, [
    join(axisRoot, 'scripts', 'axis.py'),
    'local-dev',
    '--compose-overlay',
    overlay,
    'up',
    '--build',
    'api',
  ]);
  assert.deepEqual(matchingInvocation.arguments, invocation.arguments);
  assert.deepEqual(await readFile(join(outputRoot, 'release-key.pem')), keyBefore);
  assert.deepEqual(
    await readFile(release.AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE),
    artifactBefore,
  );
});

test('topology recovery requires exact confirmation before preparation', async () => {
  for (const confirmation of [undefined, 'yes', '--YES', '--yes', '--force']) {
    await assert.rejects(
      () =>
        prepareTopologyRecoveryInvocation('/missing-axis', {
          confirmation: confirmation === '--yes' ? ['--yes'] : confirmation,
        }),
      /requires the exact confirmation argument --yes/,
    );
  }
});

test('topology recovery fails closed without creating missing release state', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-recovery-missing-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const currentProductRoot = join(temporaryRoot, 'product');
  const outputRoot = join(temporaryRoot, 'release-output');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(currentProductRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(
    join(currentProductRoot, 'deploy', 'local.compose.yml'),
    'services: {}\n',
  );
  await cp(join(process.cwd(), 'solution'), join(currentProductRoot, 'solution'), {
    recursive: true,
  });

  await assert.rejects(
    () =>
      prepareTopologyRecoveryInvocation(axisRoot, {
        confirmation: '--yes',
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
      }),
    /signing key is missing.*no replacement key was generated/s,
  );
  await assert.rejects(() => stat(outputRoot), { code: 'ENOENT' });

  await mkdir(outputRoot, { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPath = join(outputRoot, 'release-key.pem');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const keyBefore = await readFile(keyPath);
  await assert.rejects(
    () =>
      prepareTopologyRecoveryInvocation(axisRoot, {
        confirmation: '--yes',
        currentProductRoot,
        getuid: () => 1000,
        outputRoot,
      }),
    /immutable solution artifact is missing.*do not rebuild it/s,
  );
  assert.deepEqual(await readFile(keyPath), keyBefore);
  await assert.rejects(
    () => stat(join(outputRoot, 'reference_application-0.1.6.dsse.json')),
    { code: 'ENOENT' },
  );
});

test('topology recovery rejects invalid or mismatched Axis topology markers', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-recovery-owned-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  await mkdir(join(axisRoot, '.local'), { recursive: true });
  await writeFile(join(axisRoot, '.local', 'local-dev-topology.json'), 'not-json');

  await assert.rejects(
    () =>
      prepareTopologyRecoveryInvocation(axisRoot, {
        confirmation: '--yes',
      }),
    /topology state is invalid/,
  );

  await writeFile(
    join(axisRoot, '.local', 'local-dev-topology.json'),
    JSON.stringify({
      version: 1,
      composeOverlays: [join(temporaryRoot, 'different.compose.yml')],
    }),
  );
  await assert.rejects(
    () =>
      prepareTopologyRecoveryInvocation(axisRoot, {
        confirmation: '--yes',
      }),
    /cannot change Axis’s recorded deployment topology.*normal deployment wrapper that owns the recorded topology/s,
  );
});

test('builds the finite Axis overlay command without product identity in Axis source', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const productRoot = join(temporaryRoot, 'product');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(productRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(join(productRoot, 'deploy', 'local.compose.yml'), 'services: {}\n', 'utf8');

  const invocation = buildAxisInvocation('recreate', axisRoot, productRoot, () => 1000);
  assert.equal(invocation.cwd, axisRoot);
  assert.deepEqual(invocation.arguments, [
    join(axisRoot, 'scripts', 'axis.py'),
    'local-dev',
    '--compose-overlay',
    join(productRoot, 'deploy', 'local.compose.yml'),
    'recreate',
    'api',
    'reference-product',
  ]);
  assert.equal(invocation.environment.AXIS_REFERENCE_PRODUCT_ROOT, productRoot);
  assert.equal(invocation.environment.AXIS_REFERENCE_PRODUCT_UID, '1000');
});

test('builds only the reference product image before its E2E runner', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const productRoot = join(temporaryRoot, 'product');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(productRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(join(productRoot, 'deploy', 'local.compose.yml'), 'services: {}\n', 'utf8');

  const invocation = buildAxisInvocation('e2e', axisRoot, productRoot, () => 1000);
  assert.deepEqual(invocation.arguments, [
    join(axisRoot, 'scripts', 'axis.py'),
    'local-dev',
    '--compose-overlay',
    join(productRoot, 'deploy', 'local.compose.yml'),
    'e2e',
    '--build-service',
    'reference-product',
    '--service',
    'reference-product-e2e',
  ]);
});

test('runs Axis browser evidence through the product-owned topology and forwards runner arguments', async (t) => {
  const temporaryRoot = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'axis-reference-product-'),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const axisRoot = join(temporaryRoot, 'axis');
  const productRoot = join(temporaryRoot, 'product');
  await mkdir(join(axisRoot, 'scripts'), { recursive: true });
  await mkdir(join(productRoot, 'deploy'), { recursive: true });
  await writeFile(join(axisRoot, 'scripts', 'axis.py'), '', 'utf8');
  await writeFile(join(productRoot, 'deploy', 'local.compose.yml'), 'services: {}\n', 'utf8');

  const invocation = buildAxisInvocation(
    'axis-e2e',
    axisRoot,
    productRoot,
    () => 1000,
    ['--', 'e2e/app-frame.pw.ts', '-g', 'AT-002'],
  );
  assert.deepEqual(invocation.arguments, [
    join(axisRoot, 'scripts', 'axis.py'),
    'local-dev',
    '--compose-overlay',
    join(productRoot, 'deploy', 'local.compose.yml'),
    'e2e',
    '--service',
    'e2e',
    '--',
    'e2e/app-frame.pw.ts',
    '-g',
    'AT-002',
  ]);
});

test('keeps the Axis browser service owned by the product wrapper', () => {
  for (const additionalArguments of [
    ['--service', 'reference-product-e2e'],
    ['--build-service', 'api'],
    ['e2e/app-frame.pw.ts'],
    ['--snapshot-output', 'e2e/app-frame.pw.ts-snapshots'],
  ]) {
    assert.throws(
      () =>
        buildAxisInvocation(
          'axis-e2e',
          process.cwd(),
          process.cwd(),
          () => 1000,
          additionalArguments,
        ),
      /axis-e2e accepts only Playwright arguments after `--`/,
    );
  }
});

test('requires a numeric non-root POSIX UID', () => {
  for (const uid of [0, -1, 1.5, Number.NaN, '1000']) {
    assert.throws(
      () => resolveReferenceProductUid(() => uid),
      /AXIS_REFERENCE_PRODUCT_UID must be a numeric non-root POSIX UID/,
    );
  }
});

test('rejects hosts without process.getuid without mutating process state', () => {
  assert.throws(
    () => resolveReferenceProductUid(undefined),
    /cannot establish AXIS_REFERENCE_PRODUCT_UID without process\.getuid\(\)/,
  );
});

test('rejects commands outside the finite lifecycle surface', () => {
  assert.throws(
    () => buildAxisInvocation('shell', '/unused'),
    /Unsupported local-dev command: shell/,
  );
});
