import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildSolutionPackage,
  loadSolutionSource,
  verifySolutionEnvelope,
  writeImmutableSolutionArtifact,
} from './build-solution.mjs';

const productRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localEnvironment = resolve(productRoot, '.env.local');

export const localDevCommands = Object.freeze({
  up: ['up', '--build'],
  down: ['down'],
  status: ['status'],
  logs: ['logs', 'reference-product'],
  recreate: ['recreate', 'api', 'reference-product'],
  e2e: ['e2e', '--build-service', 'reference-product', '--service', 'reference-product-e2e'],
  'axis-e2e': ['e2e', '--service', 'e2e'],
  'recover-topology': ['up', '--build', 'api'],
});
const releaseCommands = new Set(['up', 'recreate', 'e2e']);

function assertAxisE2eArguments(additionalArguments) {
  if (additionalArguments.length === 0 || additionalArguments[0] === '--') return;
  if (
    additionalArguments.length >= 3 &&
    additionalArguments[0] === '--snapshot-output' &&
    additionalArguments[1] &&
    additionalArguments[2] === '--'
  ) {
    return;
  }
  throw Error(
    'axis-e2e accepts only Playwright arguments after `--`, optionally preceded by one `--snapshot-output <path>`.',
  );
}

export function resolveReferenceProductUid(getuid) {
  if (typeof getuid !== 'function') {
    throw Error('Unsupported host: cannot establish AXIS_REFERENCE_PRODUCT_UID without process.getuid().');
  }
  const uid = getuid();
  if (!Number.isInteger(uid) || uid <= 0) {
    throw Error('Unsupported host: AXIS_REFERENCE_PRODUCT_UID must be a numeric non-root POSIX UID.');
  }
  return String(uid);
}

export async function prepareSolutionRelease({
  allowArtifactCreation = true,
  allowKeyGeneration = true,
  outputRoot = resolve(productRoot, '.axis-solution'),
  productRoot: currentProductRoot = productRoot,
  sourceRevision,
} = {}) {
  const keyPath = join(outputRoot, 'release-key.pem');
  if (!existsSync(keyPath)) {
    const existingArtifacts = existsSync(outputRoot)
      ? (await readdir(outputRoot)).filter((entry) => entry.endsWith('.dsse.json'))
      : [];
    if (!allowKeyGeneration || existingArtifacts.length > 0) {
      throw Error(
        `Reference-product signing key is missing for the existing local deployment in ${outputRoot}. ` +
          'Restore .axis-solution/release-key.pem; do not generate a replacement key, rotate the existing key identity, or reset the database.',
      );
    }
    await mkdir(outputRoot, { recursive: true });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    try {
      await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  await chmod(keyPath, 0o600);
  const privateKey = await readFile(keyPath, 'utf8');
  const publicKey = createPublicKey(privateKey);
  const built = await buildSolutionPackage({
    privateKey,
    productRoot: currentProductRoot,
    sourceRevision,
  });
  const packagePath = join(
    outputRoot,
    `${built.payload.solutionKey}-${built.payload.solutionVersion}.dsse.json`,
  );
  if (!allowArtifactCreation && !existsSync(packagePath)) {
    throw Error(
      `The immutable solution artifact is missing for the existing local deployment: ${packagePath}. ` +
        'Restore that exact artifact; do not rebuild it under the same solution version or reset the database.',
    );
  }
  await writeImmutableSolutionArtifact(packagePath, built, publicKey);
  return {
    AXIS_REFERENCE_PRODUCT_PUBLISHER_PUBLIC_KEY: publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE: packagePath,
  };
}

async function readExistingSolutionReleaseEnvironment({
  expectedAxisOpenApiSha256,
  outputRoot = resolve(productRoot, '.axis-solution'),
  productRoot: currentProductRoot = productRoot,
} = {}) {
  const keyPath = join(outputRoot, 'release-key.pem');
  if (!existsSync(keyPath)) {
    throw Error(
      `Reference-product signing key is missing for the existing local deployment in ${outputRoot}. ` +
        'Restore .axis-solution/release-key.pem before running passive local-dev commands; no replacement key was generated.',
    );
  }
  const { release } = await loadSolutionSource({ productRoot: currentProductRoot });
  const packagePath = join(
    outputRoot,
    `${release.solutionKey}-${release.solutionVersion}.dsse.json`,
  );
  if (!existsSync(packagePath)) {
    throw Error(
      `The existing immutable solution artifact is missing: ${packagePath}. ` +
        'Restore the artifact that belongs to the persisted signing key and release; passive local-dev commands do not rebuild it.',
    );
  }
  const privateKey = await readFile(keyPath, 'utf8');
  const publicKey = createPublicKey(privateKey);
  let verified;
  try {
    verified = verifySolutionEnvelope(await readFile(packagePath), publicKey);
  } catch (error) {
    throw Error(
      `The existing immutable solution artifact failed signature or canonical-envelope verification: ${packagePath}.`,
      { cause: error },
    );
  }
  const { payload } = verified;
  const identityMatches =
    payload.schemaVersion === 1 &&
    payload.solutionKey === release.solutionKey &&
    payload.solutionVersion === release.solutionVersion &&
    payload.publisher?.publisherId === release.publisher.publisherId &&
    payload.publisher?.publisherKeyId === release.publisher.publisherKeyId &&
    payload.provenance?.buildId === release.provenance.buildId &&
    payload.provenance?.builtAt === release.provenance.builtAt &&
    payload.provenance?.sourceUri === release.provenance.sourceUri;
  if (!identityMatches) {
    throw Error(
      `The existing immutable solution artifact does not match the declared release identity: ${packagePath}.`,
    );
  }
  if (
    expectedAxisOpenApiSha256 &&
    payload.axisOpenApiSha256 !== expectedAxisOpenApiSha256
  ) {
    throw Error(
      `The existing immutable solution artifact targets Axis OpenAPI ${payload.axisOpenApiSha256 ?? 'without a digest'}, ` +
        `but the recorded deployment requires ${expectedAxisOpenApiSha256}.`,
    );
  }
  return {
    AXIS_REFERENCE_PRODUCT_PUBLISHER_PUBLIC_KEY: publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE: packagePath,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function assertAxisOpenApiCompatibility(
  axisRoot,
  currentProductRoot = productRoot,
) {
  const resolvedAxisRoot = resolve(axisRoot);
  const axisOpenApiPath = resolve(resolvedAxisRoot, 'openapi.json');
  const axisSettingsPath = resolve(resolvedAxisRoot, 'src', 'Axis.Api', 'appsettings.json');
  const productOpenApiPath = resolve(currentProductRoot, 'openapi.json');
  const [axisOpenApi, productOpenApi, axisSettingsBytes] = await Promise.all([
    readFile(axisOpenApiPath),
    readFile(productOpenApiPath),
    readFile(axisSettingsPath),
  ]);
  const axisDigest = sha256(axisOpenApi);
  const productDigest = sha256(productOpenApi);
  const configuredDigest = JSON.parse(axisSettingsBytes.toString('utf8')).Solutions
    ?.AxisOpenApiSha256;
  if (configuredDigest !== axisDigest) {
    throw Error(
      `Axis OpenAPI metadata is stale: openapi.json is ${axisDigest}, ` +
        `but src/Axis.Api/appsettings.json declares ${configuredDigest ?? 'no digest'}. ` +
        'Regenerate Axis API contracts before starting the reference product.',
    );
  }
  if (productDigest !== axisDigest) {
    throw Error(
      `Reference-product OpenAPI is incompatible with the current Axis platform ` +
        `(product ${productDigest}, Axis ${axisDigest}). ` +
        'Sync openapi.json and generated clients from Axis, then bump the immutable solution release version before starting or testing the product.',
    );
  }
  return axisDigest;
}

async function recordedAxisTopology(axisRoot) {
  const statePath = resolve(axisRoot, '.local', 'local-dev-topology.json');
  if (!existsSync(statePath)) return null;
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    throw Error(`Axis local deployment topology state is invalid: ${statePath}`, {
      cause: error,
    });
  }
  if (
    state?.version !== 1 ||
    !Array.isArray(state.composeOverlays) ||
    state.composeOverlays.length === 0 ||
    state.composeOverlays.some((entry) => typeof entry !== 'string' || !isAbsolute(entry))
  ) {
    throw Error(`Axis local deployment topology state is invalid: ${statePath}`);
  }
  return state.composeOverlays.map((entry) => resolve(entry));
}

export function buildAxisInvocation(
  command,
  axisRoot,
  currentProductRoot = productRoot,
  getuid = process.getuid,
  additionalArguments = [],
) {
  const commandArguments = localDevCommands[command];
  if (!commandArguments) {
    throw Error(`Unsupported local-dev command: ${command}`);
  }
  if (command === 'axis-e2e') assertAxisE2eArguments(additionalArguments);
  const resolvedAxisRoot = resolve(axisRoot);
  const axisScript = resolve(resolvedAxisRoot, 'scripts', 'axis.py');
  if (!existsSync(axisScript)) {
    throw Error(`AXIS_PLATFORM_ROOT does not contain scripts/axis.py: ${resolvedAxisRoot}`);
  }
  const overlay = resolve(currentProductRoot, 'deploy', 'local.compose.yml');
  if (!existsSync(overlay)) throw Error(`Product deployment overlay is missing: ${overlay}`);
  return {
    cwd: resolvedAxisRoot,
    environment: {
      ...process.env,
      AXIS_PLATFORM_ROOT: resolvedAxisRoot,
      AXIS_REFERENCE_PRODUCT_ROOT: resolve(currentProductRoot),
      AXIS_REFERENCE_PRODUCT_UID: resolveReferenceProductUid(getuid),
    },
    executable: 'python',
    arguments: [
      axisScript,
      'local-dev',
      '--compose-overlay',
      overlay,
      ...commandArguments,
      ...additionalArguments,
    ],
  };
}

export async function prepareLocalDevInvocation(
  command,
  axisRoot,
  {
    currentProductRoot = productRoot,
    getuid = process.getuid,
    outputRoot = resolve(currentProductRoot, '.axis-solution'),
    sourceRevision,
    additionalArguments = [],
  } = {},
) {
  if (command === 'recover-topology') {
    throw Error('Use the confirmed topology-recovery preparation path.');
  }
  const invocation = buildAxisInvocation(
    command,
    axisRoot,
    currentProductRoot,
    getuid,
    additionalArguments,
  );
  const requiresCurrentRelease = releaseCommands.has(command);
  const requiresCompatibleRelease = requiresCurrentRelease || command === 'axis-e2e';
  if (requiresCompatibleRelease) {
    const axisOpenApiSha256 = await assertAxisOpenApiCompatibility(
      axisRoot,
      currentProductRoot,
    );
    const recordedTopology = await recordedAxisTopology(axisRoot);
    const requestedTopology = [resolve(currentProductRoot, 'deploy', 'local.compose.yml')];
    if (
      recordedTopology !== null &&
      (recordedTopology.length !== requestedTopology.length ||
        recordedTopology.some((entry, index) => entry !== requestedTopology[index]))
    ) {
      throw Error(
        'The reference-product wrapper does not match Axis’s recorded local deployment topology. ' +
          'Use the deployment wrapper that owns the recorded overlays or explicitly reset all local data before changing topology.',
      );
    }
    Object.assign(
      invocation.environment,
      requiresCurrentRelease
        ? await prepareSolutionRelease({
            allowArtifactCreation: recordedTopology === null,
            allowKeyGeneration: recordedTopology === null,
            outputRoot,
            productRoot: currentProductRoot,
            sourceRevision,
          })
        : await readExistingSolutionReleaseEnvironment({
            expectedAxisOpenApiSha256: axisOpenApiSha256,
            outputRoot,
            productRoot: currentProductRoot,
          }),
    );
  } else {
    Object.assign(
      invocation.environment,
      await readExistingSolutionReleaseEnvironment({
        outputRoot,
        productRoot: currentProductRoot,
      }),
    );
  }
  return invocation;
}

export async function prepareTopologyRecoveryInvocation(
  axisRoot,
  {
    confirmation,
    currentProductRoot = productRoot,
    getuid = process.getuid,
    outputRoot = resolve(currentProductRoot, '.axis-solution'),
  } = {},
) {
  if (confirmation !== '--yes') {
    throw Error('Topology recovery requires the exact confirmation argument --yes.');
  }
  const resolvedAxisRoot = resolve(axisRoot);
  const recordedTopology = await recordedAxisTopology(resolvedAxisRoot);
  const requestedTopology = [resolve(currentProductRoot, 'deploy', 'local.compose.yml')];
  if (
    recordedTopology !== null &&
    (recordedTopology.length !== requestedTopology.length ||
      recordedTopology.some((entry, index) => entry !== requestedTopology[index]))
  ) {
    throw Error(
      'Topology recovery cannot change Axis’s recorded deployment topology. ' +
        'Use the normal deployment wrapper that owns the recorded topology.',
    );
  }
  const invocation = buildAxisInvocation(
    'recover-topology',
    resolvedAxisRoot,
    currentProductRoot,
    getuid,
  );
  Object.assign(
    invocation.environment,
    await readExistingSolutionReleaseEnvironment({
      outputRoot,
      productRoot: currentProductRoot,
    }),
  );
  return invocation;
}

function sourceRevision() {
  const configured = process.env.AXIS_SOLUTION_SOURCE_REVISION;
  if (configured) return configured;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: productRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw Error('Could not resolve the reference-product source revision.');
  return result.stdout.trim();
}

async function main() {
  const command = process.argv[2];
  const additionalArguments = command === 'axis-e2e' ? process.argv.slice(3) : [];
  if (
    command === 'recover-topology' &&
    (process.argv.length !== 4 || process.argv[3] !== '--yes')
  ) {
    throw Error('Topology recovery requires the exact confirmation argument --yes.');
  }
  if (
    !command ||
    (command === 'recover-topology'
      ? process.argv.length !== 4
      : command !== 'axis-e2e' && process.argv.length !== 3)
  ) {
    throw Error(`Usage: node scripts/local-dev.mjs <${Object.keys(localDevCommands).join('|')}>`);
  }
  if (existsSync(localEnvironment)) process.loadEnvFile(localEnvironment);
  const axisRoot = process.env.AXIS_PLATFORM_ROOT;
  if (!axisRoot) {
    throw Error('Set AXIS_PLATFORM_ROOT in .env.local before running local development.');
  }
  const invocation =
    command === 'recover-topology'
      ? await prepareTopologyRecoveryInvocation(axisRoot, { confirmation: process.argv[3] })
      : await prepareLocalDevInvocation(command, axisRoot, {
          sourceRevision: releaseCommands.has(command) ? sourceRevision() : undefined,
          additionalArguments,
        });
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
