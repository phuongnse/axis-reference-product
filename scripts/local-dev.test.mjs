import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildAxisInvocation,
  prepareSolutionRelease,
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
