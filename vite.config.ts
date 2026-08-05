import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-openapi-contract',
      apply: 'build',
      buildStart() {
        this.emitFile({
          type: 'asset',
          fileName: 'openapi.json',
          source: readFileSync(new URL('./openapi.json', import.meta.url)),
        });
      },
    },
  ],
});
