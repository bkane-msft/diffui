'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createEditableRepo, startServer, rmRepo } = require('./harness');

// Brand-new (untracked) files are invisible to `git diff`; the app folds them
// into the working-tree view as added files. These tests prove they show up,
// mount an editable inline Monaco diff, and save to disk with correct counts.
test.describe.configure({ mode: 'serial' });

const UNTRACKED = 'brand-new.js';

let repoDir;
let server;

test.beforeAll(async () => {
  ({ dir: repoDir } = createEditableRepo());
  // A file that has never been `git add`ed.
  fs.writeFileSync(
    path.join(repoDir, UNTRACKED),
    'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n'
  );
  server = await startServer(repoDir);
});

test.afterAll(async () => {
  if (server) await server.stop();
  rmRepo(repoDir);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('diffui.filebar', 'open'); } catch { /* ignore */ }
  });
});

const cardId = (p) => 'file-' + p.replace(/[^a-zA-Z0-9]/g, '_');
const cardSel = (p) => '#' + cardId(p);

async function mountCard(page, p) {
  await page.click(`li[data-path="${p}"]`);
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center' });
  }, cardSel(p));
  await page.waitForSelector(`${cardSel(p)} .monaco-diff-editor`, { timeout: 20_000 });
}

test('an untracked file appears in the list as an added file with add counts', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  // Present in the sidebar file list.
  const row = page.locator(`li[data-path="${UNTRACKED}"]`);
  await expect(row).toHaveCount(1);
  // Shown as additions (three new lines), no deletions.
  await expect(page.locator(`${cardSel(UNTRACKED)} .filecard-head .counts .add`)).toContainText('+3');
});

test('an untracked file mounts an editable inline Monaco diff (no Edit button)', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, UNTRACKED);

  await expect(page.locator(`${cardSel(UNTRACKED)} .monaco-host .monaco-diff-editor`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  // Editable => a Save button exists (starts disabled until edited).
  await expect(page.locator(`${cardSel(UNTRACKED)} .card-actions button:has-text("Save")`)).toHaveCount(1);
});

test('editing an untracked file saves to disk and keeps its add counts', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, UNTRACKED);

  const save = page.locator(`${cardSel(UNTRACKED)} .card-actions button:has-text("Save")`);
  await expect(save).toBeDisabled();

  await page.locator(`${cardSel(UNTRACKED)} .monaco-host .view-lines`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // added');
  await expect(save).toBeEnabled();

  await save.click();
  await expect(save).toBeDisabled();
  await expect
    .poll(() => fs.readFileSync(path.join(repoDir, UNTRACKED), 'utf8'))
    .toContain('// added');

  // The file is still untracked, so counts must reflect its contents as
  // all-additions rather than collapsing to zero after the save.
  await expect(page.locator(`${cardSel(UNTRACKED)} .filecard-head .counts .add`)).toContainText('+3');
  await expect(page.locator(`${cardSel(UNTRACKED)} .filecard-head .counts .del`)).toContainText('0');
});
