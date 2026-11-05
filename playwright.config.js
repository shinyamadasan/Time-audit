import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Needs packaged bytes from scripts/build-release-artifacts.mjs; run with npm run test:release-artifacts.
  testIgnore: process.env.CHRONASENSE_RELEASE_DIR ? [] : ['**/accounting-release-artifacts.spec.js'],
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    // The shipped accounting transport is real REST. No test may ever reach a production database.
    launchOptions: { args: ['--host-resolver-rules=MAP *.firebasedatabase.app ~NOTFOUND, MAP *.firebaseio.com ~NOTFOUND'] }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
