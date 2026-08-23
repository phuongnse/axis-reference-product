import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stop as stopEsbuild } from 'esbuild';
import { build as buildVite } from 'vite';

export async function buildFrontend({ build = buildVite, stop = stopEsbuild } = {}) {
  try {
    return await build();
  } finally {
    await stop();
  }
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await buildFrontend();
