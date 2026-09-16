'use strict';

const { test, expect } = require('@playwright/test');
const { createStagedRepo, startServer, rmRepo } = require('./harness');

// A repo launched with --staged is read-only (the diff target is the index, not
// the working tree). Read-only diffs still render in Monaco for consistent,
// syntax-highlighted output, but the editor is read-only and the working-file
// endpoint refuses writes.
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

test('read-only diff reports editable=false; GET serves content, POST is refused', async ({ request }) => {
  const session = await (await request.get(server.baseURL + '/api/session')).json();
  expect(session.editable).toBe(false);

  // GET now serves both sides so read-only diffs can render in Monaco.
  const res = await request.get(server.baseURL + '/api/file?path=ro.js');
  expect(res.status()).toBe(200);
  const file = await res.json();
  expect(file.editable).toBe(false);
  expect(file.content).toContain('export const value = 2;');
  expect(file.base).toContain('export const value = 1;');

  // Writes stay forbidden on a read-only diff.
  const post = await request.post(server.baseURL + '/api/file', {
    data: { path: 'ro.js', content: 'export const value = 999;\n' },
  });
  expect(post.status()).toBe(403);
});

test('read-only file renders a read-only Monaco editor with syntax highlighting and no Save', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await page.click('li[data-path="ro.js"]');
  await page.evaluate(() => {
    document.querySelector('#file-ro_js')?.scrollIntoView({ block: 'center' });
  });

  // Monaco mounts (no textual fallback table anywhere anymore).
  await page.waitForSelector('#file-ro_js .monaco-diff-editor', { timeout: 20_000 });
  await expect(page.locator('#file-ro_js .monaco-diff-editor')).toBeVisible();

  // No Save button on a read-only card.
  await expect(page.locator('#file-ro_js .card-actions button:has-text("Save")')).toHaveCount(0);

  // Syntax highlighting is active (Monaco token spans) even though read-only.
  await expect
    .poll(async () => page.locator('#file-ro_js .view-lines span[class*="mtk"]').count())
    .toBeGreaterThan(0);

  // The read-only diff still shows the staged change.
  await expect(page.locator('#file-ro_js')).toContainText('export const value = 2;');
});
