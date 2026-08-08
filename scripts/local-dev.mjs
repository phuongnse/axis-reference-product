import { createPublicKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSolutionPackage, solutionPayloadType } from './build-solution.mjs';

const productRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localEnvironment = resolve(productRoot, '.env.local');

export const localDevCommands = Object.freeze({
  up: ['up', '--build'],
  down: ['down'],
  status: ['status'],
  logs: ['logs', 'reference-product'],
  recreate: ['recreate', 'api', 'reference-product'],
  e2e: ['e2e', '--build-service', 'reference-product', '--service', 'reference-product-e2e'],
});

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
  outputRoot = resolve(productRoot, '.axis-solution'),
  sourceRevision,
} = {}) {
  await mkdir(outputRoot, { recursive: true });
  const keyPath = join(outputRoot, 'release-key.pem');
  if (!existsSync(keyPath)) {
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
  const built = await buildSolutionPackage({ privateKey, sourceRevision });
  const packagePath = join(
    outputRoot,
    `${built.payload.solutionKey}-${built.payload.solutionVersion}.dsse.json`,
  );
  let reusePackage = false;
  if (existsSync(packagePath)) {
    try {
      const existingBytes = await readFile(packagePath);
      const existing = JSON.parse(existingBytes.toString('utf8'));
      const signature = existing.signatures?.[0];
      reusePackage =
        existing.payloadType === solutionPayloadType &&
        existing.payload === built.payloadBytes.toString('base64url') &&
        existing.signatures?.length === 1 &&
        signature?.keyid === built.payload.publisher.publisherKeyId &&
        typeof signature.sig === 'string' &&
        verifySignature(
          'sha256',
          built.paeBytes,
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature.sig, 'base64url'),
        );
    } catch {
      reusePackage = false;
    }
  }
  if (!reusePackage) await writeFile(packagePath, built.envelopeBytes);
  return {
    AXIS_REFERENCE_PRODUCT_PUBLISHER_PUBLIC_KEY: publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    AXIS_REFERENCE_PRODUCT_SOLUTION_PACKAGE: packagePath,
  };
}

export function buildAxisInvocation(
  command,
  axisRoot,
  currentProductRoot = productRoot,
  getuid = process.getuid,
) {
  const commandArguments = localDevCommands[command];
  if (!commandArguments) {
    throw Error(`Unsupported local-dev command: ${command}`);
  }
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
    ],
  };
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
  if (existsSync(localEnvironment)) process.loadEnvFile(localEnvironment);
  const command = process.argv[2];
  if (!command || process.argv.length !== 3) {
    throw Error(`Usage: node scripts/local-dev.mjs <${Object.keys(localDevCommands).join('|')}>`);
  }
  const axisRoot = process.env.AXIS_PLATFORM_ROOT;
  if (!axisRoot) {
    throw Error('Set AXIS_PLATFORM_ROOT in .env.local before running local development.');
  }
  const invocation = buildAxisInvocation(command, axisRoot);
  Object.assign(
    invocation.environment,
    await prepareSolutionRelease({ sourceRevision: sourceRevision() }),
  );
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
