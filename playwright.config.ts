import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw Error('E2E_BASE_URL is required; run npm run test:e2e.');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.pw.ts',
  // Real-service acceptance owns one bounded suite budget; tests must not override it locally.
  timeout: 45_000,
  outputDir: process.env.E2E_OUTPUT_DIR ?? './test-results',
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: process.env.E2E_REPORT_DIR ?? './playwright-report',
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
