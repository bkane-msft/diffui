'use strict';

const { test, expect } = require('@playwright/test');
const { createEditableRepo, startServer, rmRepo } = require('./harness');

// The Compare panel holds the revision inputs AND, below them, this repo's
// history list (there is no separate History button).
test.describe.configure({ mode: 'serial' });

let repoDir;
let server;

test.beforeAll(async () => {
  ({ dir: repoDir } = createEditableRepo());
  server = await startServer(repoDir);
});

test.afterAll(async () => {
  if (server) await server.stop();
  rmRepo(repoDir);
});

test('there is no separate History button in the top bar', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await expect(page.locator('#historyBtn')).toHaveCount(0);
  await expect(page.locator('#compareBtn')).toBeVisible();
});

test('Compare panel shows the revision inputs and the repo history below them', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  await page.click('#compareBtn');

  const modal = page.locator('#modal');
  await expect(modal.getByText('Compare revisions')).toBeVisible();
  // Existing inputs are still there.
  await expect(modal.locator('input')).toHaveCount(2);
  // History section renders below the inputs.
  await expect(modal.getByText('History — this repo')).toBeVisible();
  // The server records a launch on startup, so at least one entry appears with
  // an Open button; wait for the async /api/history load to populate the list.
  const firstOpen = modal.locator('.history-list li button', { hasText: 'Open' }).first();
  await expect(firstOpen).toBeVisible();
});

test('opening a history entry from the Compare panel switches the diff', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  await page.click('#compareBtn');
  const modal = page.locator('#modal');
  await modal.locator('.history-list li button', { hasText: 'Open' }).first().click();

  // The modal closes and the diff re-renders (cards still present).
  await expect(page.locator('#modalBackdrop')).toBeHidden();
  await page.waitForSelector('.filecard');
});
