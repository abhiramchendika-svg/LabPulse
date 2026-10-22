import { defineConfig } from '@playwright/test';

// Runs against a LabPulse server that is already running (npm start / docker compose up).
export default defineConfig({
  testDir: '.',
  timeout: 600_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.LABPULSE_URL ?? 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
  },
});
