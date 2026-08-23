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
  const processManifest = JSON.parse(await readFile(resolve(root, '.process/project.json'), 'utf8'));
  const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');
  const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const copyInstruction = `COPY ${buildEntrypoint} ./${buildEntrypoint}`;
  const buildInstruction = 'RUN npm ci && npm run generate:api && npm run build';
  const imageCheck = processManifest.profiles.review.find(({ id }) => id === 'production-image');

  assert.equal(packageManifest.scripts.build, `tsc --noEmit && node ${buildEntrypoint}`);
  assert.ok(dockerfile.includes(copyInstruction));
  assert.ok(dockerfile.indexOf(copyInstruction) < dockerfile.indexOf(buildInstruction));
  assert.doesNotMatch(dockerfile, /^COPY scripts\/ \.\/scripts\/$/mu);
  assert.deepEqual(imageCheck.run, [
    'docker',
    'build',
    '--tag',
    'axis-reference-product:process-review',
    '.',
  ]);
  assert.ok(processManifest.environment.profiles.review.includes('docker-runtime'));
  assert.match(workflow, /- name: Run governed review profile\n\s+if: runner\.os == 'Linux'\n\s+run: processctl verify --project-root \. --profile review/u);
  assert.doesNotMatch(workflow, /run: docker build/u);
});
