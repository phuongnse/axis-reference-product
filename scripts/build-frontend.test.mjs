import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFrontend } from './build-frontend.mjs';

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
