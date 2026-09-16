// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Playwright config for the git-diffui frontend E2E suite.
//
// Each spec spawns its own ./git-diffui binary against its own temporary git
// repo (see test/e2e/harness.js), so there is no shared web server here and no
// global baseURL. Tests are hermetic and safe to run in parallel across files,
// but within a file we run serially because they share one server + fixture.
module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: Monaco is CPU-heavy and each spec file spawns its own binary +
  // Chromium. Running files in parallel starves editor mounts and makes the
  // heavier fixtures (tall/large) flake, so keep the whole suite serial.
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    headless: true,
    trace: 'retain-on-failure',
    // Monaco needs a real-ish viewport; the lazy IntersectionObserver mount is
    // driven by scrolling cards into view inside the tests.
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      // Desktop Chrome defaults to a 720px-tall viewport; pin a taller one so
      // lazily-mounted cards lower in the list are reliably scrolled into view.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
});
