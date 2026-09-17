'use strict';

const { test, expect } = require('@playwright/test');
const { createEditableRepo, startServer, rmRepo } = require('./harness');

// The Wrap button toggles word wrap across all editors (current and newly
// mounted) and remembers the choice.
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

const wordWrapValues = (page) =>
  page.evaluate(() =>
    window.monaco.editor
      .getEditors()
      .map((e) => e.getOption(window.monaco.editor.EditorOption.wordWrap))
  );

test('word wrap is off by default and the Wrap button turns it on for every editor', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.monaco-diff-editor');

  const wrapBtn = page.locator('#wrapBtn');
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false');

  const before = await wordWrapValues(page);
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((v) => v === 'off')).toBe(true);

  await wrapBtn.click();
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(wrapBtn).toHaveClass(/active/);
  await expect.poll(async () => (await wordWrapValues(page)).every((v) => v === 'on')).toBe(true);

  await wrapBtn.click();
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await wordWrapValues(page)).every((v) => v === 'off')).toBe(true);
});

test('the word wrap choice persists across a reload and applies to new editors', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.monaco-diff-editor');

  await page.locator('#wrapBtn').click();
  await expect(page.locator('#wrapBtn')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await page.waitForSelector('.monaco-diff-editor');
  await expect(page.locator('#wrapBtn')).toHaveAttribute('aria-pressed', 'true');
  // Editors mounted after reload come up already wrapped (via diffOpts).
  await expect.poll(async () => (await wordWrapValues(page)).every((v) => v === 'on')).toBe(true);
});
