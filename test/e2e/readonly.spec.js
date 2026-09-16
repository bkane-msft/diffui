'use strict';

const { test, expect } = require('@playwright/test');
const { createStagedRepo, startServer, rmRepo } = require('./harness');

// A repo launched with --staged is read-only (the diff target is the index, not
// the working tree). The UI must fall back to textual diff tables and the
// working-file endpoint must refuse edits.
test.describe.configure({ mode: 'serial' });

let repoDir;
let server;

test.beforeAll(async () => {
  ({ dir: repoDir } = createStagedRepo());
  server = await startServer(repoDir, ['--staged']);
});

test.afterAll(async () => {
  if (server) await server.stop();
  rmRepo(repoDir);
});

test('read-only diff reports editable=false and refuses /api/file', async ({ request }) => {
  const session = await (await request.get(server.baseURL + '/api/session')).json();
  expect(session.editable).toBe(false);

  const res = await request.get(server.baseURL + '/api/file?path=ro.js');
  expect(res.status()).toBe(403);
});

test('read-only file renders a textual diff table and no Monaco editor', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await page.click('li[data-path="ro.js"]');

  await expect(page.locator('#file-ro_js .diff-table')).toBeVisible();
  await expect(page.locator('#file-ro_js .monaco-diff-editor')).toHaveCount(0);
  // The read-only diff still shows the staged change.
  await expect(page.locator('#file-ro_js .diff-table')).toContainText('export const value = 2;');
});
