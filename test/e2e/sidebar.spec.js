'use strict';

const { test, expect } = require('@playwright/test');
const { createEditableRepo, startServer, rmRepo, EDITABLE } = require('./harness');

// The file list (sidebar) is collapsible and collapsed by default. These tests
// exercise the default state and the Files toggle, so unlike the other specs
// they must NOT pre-open it.
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

test('file list is collapsed by default and toggles open/closed via the Files button', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  const sidebar = page.locator('#sidebar');
  const filesBtn = page.locator('#filesBtn');

  // Collapsed by default: hidden and the toggle reflects it.
  await expect(sidebar).toBeHidden();
  await expect(filesBtn).toHaveAttribute('aria-expanded', 'false');

  // Open it.
  await filesBtn.click();
  await expect(sidebar).toBeVisible();
  await expect(filesBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`#filelist li[data-path="${EDITABLE.small}"]`)).toBeVisible();

  // Close it again.
  await filesBtn.click();
  await expect(sidebar).toBeHidden();
  await expect(filesBtn).toHaveAttribute('aria-expanded', 'false');
});

test('the open/closed choice persists across a reload', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  await page.locator('#filesBtn').click();
  await expect(page.locator('#sidebar')).toBeVisible();

  await page.reload();
  await page.waitForSelector('.filecard');
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#filesBtn')).toHaveAttribute('aria-expanded', 'true');
});

test('clicking a file row scrolls to and mounts that file', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  await page.locator('#filesBtn').click();
  await page.click(`li[data-path="${EDITABLE.small}"]`);

  const cardSel = '#file-' + EDITABLE.small.replace(/[^a-zA-Z0-9]/g, '_');
  await page.waitForSelector(`${cardSel} .monaco-diff-editor`, { timeout: 20_000 });
  await expect(page.locator(`${cardSel} .monaco-diff-editor`)).toBeVisible();
});
