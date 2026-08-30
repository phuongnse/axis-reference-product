import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('package, process, image, and workflow share one governed production build', async () => {
  const packageManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const processManifest = JSON.parse(await readFile(resolve(root, '.process/project.json'), 'utf8'));
  const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');
  const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const frontendCheck = processManifest.profiles.review.find(({ id }) => id === 'frontend-build');
  const imageCheck = processManifest.profiles.review.find(({ id }) => id === 'production-image');

  assert.equal(packageManifest.scripts.build, 'tsc --noEmit && vite build');
  assert.equal(packageManifest.devDependencies.esbuild, undefined);
  assert.deepEqual(frontendCheck.run, [
    'node',
    'node_modules/vite/bin/vite.js',
    'build',
  ]);
  assert.deepEqual(imageCheck.run, [
    'docker',
    'build',
    '--tag',
    'axis-reference-product:process-review',
    '.',
  ]);
  assert.match(dockerfile, /^RUN npm ci && npm run generate:api && npm run build$/mu);
  assert.match(
    workflow,
    /- name: Run governed review profile\n\s+if: runner\.os == 'Linux'\n\s+run: processctl verify --project-root \. --profile review/u,
  );
  assert.doesNotMatch(workflow, /run: docker build/u);
});
