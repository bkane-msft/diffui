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

// The file list is collapsed by default; these tests navigate by clicking its
// rows, so open it (and keep it open across this test's navigations) up front.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('diffui.filebar', 'open'); } catch { /* ignore */ }
  });
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

test('read-only deleted lines are selectable and open no context menu', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await page.click('li[data-path="ro.js"]');

  // Replacing `value = 1;` with `value = 2;` renders the old line as a deleted
  // view zone in the inline diff. Deleted-line selection/menu suppression must
  // work on read-only diffs too, since they share the same Monaco mount path.
  const deleted = page.locator('#file-ro_js .view-lines.line-delete').first();
  await deleted.waitFor({ state: 'visible', timeout: 20_000 });
  await page.addStyleTag({ content: '.filecard-head{pointer-events:none!important}' });
  await deleted.scrollIntoViewIfNeeded();
  const box = await deleted.boundingBox();
  const y = box.y + box.height / 2;

  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(box.width - 4, 40), y, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  expect(selected.replace(/\u00a0/g, ' ')).toContain('export const value = 1;');

  await page.mouse.click(box.x + box.width / 2, y);
  await expect(page.locator('.monaco-menu')).toHaveCount(0);
});
