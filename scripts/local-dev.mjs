import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

function main() {
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
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
