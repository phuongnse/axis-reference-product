import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFrontend } from './build-frontend.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildEntrypoint = 'scripts/build-frontend.mjs';

test('stops esbuild after a successful frontend build', async () => {
  const events = [];
  const result = await buildFrontend({
    build: async () => {
      events.push('build');
      return 'built';
    },
    stop: async () => events.push('stop'),
  });

  assert.equal(result, 'built');
  assert.deepEqual(events, ['build', 'stop']);
});

test('stops esbuild without masking a failed frontend build', async () => {
  const failure = new Error('build failed');
  const events = [];
  await assert.rejects(
    buildFrontend({
      build: async () => {
        events.push('build');
        throw failure;
      },
      stop: async () => events.push('stop'),
    }),
    (error) => error === failure,
  );

  assert.deepEqual(events, ['build', 'stop']);
});

test('package and production image use the same minimal frontend build entrypoint', async () => {
  const packageManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');
  const copyInstruction = `COPY ${buildEntrypoint} ./${buildEntrypoint}`;
  const buildInstruction = 'RUN npm ci && npm run generate:api && npm run build';

  assert.equal(packageManifest.scripts.build, `tsc --noEmit && node ${buildEntrypoint}`);
  assert.ok(dockerfile.includes(copyInstruction));
  assert.ok(dockerfile.indexOf(copyInstruction) < dockerfile.indexOf(buildInstruction));
  assert.doesNotMatch(dockerfile, /^COPY scripts\/ \.\/scripts\/$/mu);
});
