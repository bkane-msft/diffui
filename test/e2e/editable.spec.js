'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createEditableRepo, startServer, rmRepo, EDITABLE } = require('./harness');

// One temp repo + one server for the whole file. Tests navigate a fresh page
// each time, so DOM state is isolated; the on-disk fixture is shared, so the
// suite runs serially and the save tests use dedicated fixtures (alpha/beta).
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

const cardId = (p) => 'file-' + p.replace(/[^a-zA-Z0-9]/g, '_');
const cardSel = (p) => '#' + cardId(p);

// mountCard brings a file's card into view (the UI lazy-mounts Monaco via an
// IntersectionObserver) and waits for the inline diff editor to appear.
async function mountCard(page, p) {
  await page.click(`li[data-path="${p}"]`);
  // The sidebar click scrolls with behavior:'smooth', which for the last/tall
  // card can leave it below the fold and race the IntersectionObserver mount.
  // Force the card fully into view (instant, centered) so the same lazy-mount a
  // user gets by scrolling fires deterministically.
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center' });
  }, cardSel(p));
  await page.waitForSelector(`${cardSel(p)} .monaco-diff-editor`, { timeout: 20_000 });
}

async function hostHeight(page, p) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel + ' .monaco-host');
    return el ? el.clientHeight : -1;
  }, cardSel(p));
}

// keyboardSave triggers the editor's per-card save keybinding. The app binds
// monaco.KeyMod.CtrlCmd | KeyS; this bundled Monaco resolves CtrlCmd to Ctrl in
// headless Chromium (even on macOS), while Playwright's portable 'ControlOrMeta'
// sends Meta on macOS — so the two can disagree. Press the portable chord and,
// if the save did not fire, fall back to the other modifier. Either path
// exercises the real per-editor addAction, not a click.
async function keyboardSave(page, saveLocator) {
  await page.keyboard.press('ControlOrMeta+KeyS');
  try {
    await expect(saveLocator).toBeDisabled({ timeout: 2_000 });
  } catch {
    await page.keyboard.press('Control+KeyS');
    await expect(saveLocator).toBeDisabled({ timeout: 5_000 });
  }
}

test('editable non-binary cards auto-mount inline Monaco, with no Edit button', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.small);

  await expect(page.locator(`${cardSel(EDITABLE.small)} .monaco-host .monaco-diff-editor`)).toBeVisible();
  // Never an "Edit" button anywhere — editing is always inline.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
});

test('syntax highlighting is active (Monaco token spans) for a code file', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.small);

  await expect
    .poll(async () =>
      page.locator(`${cardSel(EDITABLE.small)} .view-lines span[class*="mtk"]`).count()
    )
    .toBeGreaterThan(0);
});

test('small file is not collapsed and shows no Expand button', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.small);

  await expect(page.locator(`${cardSel(EDITABLE.small)} .monaco-wrap.collapsed`)).toHaveCount(0);
  await expect(page.locator(`${cardSel(EDITABLE.small)} .expand-bar`)).toBeHidden();
  expect(await hostHeight(page, EDITABLE.small)).toBeLessThan(600);
});

test('card header collapse toggle hides and restores the file body', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.small);

  const card = page.locator(cardSel(EDITABLE.small));
  const body = page.locator(`${cardSel(EDITABLE.small)} .filecard-body`);
  const toggle = page.locator(`${cardSel(EDITABLE.small)} .card-toggle`);

  await expect(body).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await toggle.click();
  await expect(card).toHaveClass(/collapsed/);
  await expect(body).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(body).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('large multi-hunk file shows hidden unchanged regions that expand to reveal more', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.large);

  const hidden = page.locator(`${cardSel(EDITABLE.large)} .diff-hidden-lines`);
  await expect.poll(async () => hidden.count()).toBeGreaterThan(0);

  const before = await hostHeight(page, EDITABLE.large);
  // The unchanged-region widget's expander is an icon anchor.
  await page.locator(`${cardSel(EDITABLE.large)} .diff-hidden-lines a`).first().click();
  await expect.poll(async () => hostHeight(page, EDITABLE.large)).toBeGreaterThan(before);
});

test('tall single-change file is capped at ~600px with a working Expand/Collapse toggle', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.tall);

  const wrap = page.locator(`${cardSel(EDITABLE.tall)} .monaco-wrap`);
  await expect(wrap).toHaveClass(/collapsed/);
  const capped = await hostHeight(page, EDITABLE.tall);
  expect(capped).toBeLessThanOrEqual(640);
  expect(capped).toBeGreaterThan(400);

  const toggle = page.locator(`${cardSel(EDITABLE.tall)} .expand-bar button`);
  await expect(toggle).toBeVisible();

  await toggle.click(); // Expand
  await expect(wrap).not.toHaveClass(/collapsed/);
  await expect.poll(async () => hostHeight(page, EDITABLE.tall)).toBeGreaterThan(capped);

  await toggle.click(); // Collapse restores the cap
  await expect(wrap).toHaveClass(/collapsed/);
  await expect.poll(async () => hostHeight(page, EDITABLE.tall)).toBeLessThanOrEqual(640);
});

test('editing enables Save; both click and keyboard persist to disk and update counts', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.alpha);

  const save = page.locator(`${cardSel(EDITABLE.alpha)} .card-actions button:has-text("Save")`);
  await expect(save).toBeDisabled();

  // --- edit + save via button click ---
  await page.locator(`${cardSel(EDITABLE.alpha)} .monaco-host .view-lines`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // via-click');
  await expect(save).toBeEnabled();

  await save.click();
  await expect(save).toBeDisabled(); // returns to disabled after a successful save
  await expect
    .poll(() => fs.readFileSync(path.join(repoDir, EDITABLE.alpha), 'utf8'))
    .toContain('// via-click');

  // counts in the card head reflect the new diff (one added line).
  await expect(page.locator(`${cardSel(EDITABLE.alpha)} .filecard-head .counts .add`)).toContainText('+');

  // --- edit + save via keyboard shortcut (Cmd/Ctrl+S) ---
  await page.locator(`${cardSel(EDITABLE.alpha)} .monaco-host .view-lines`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // via-key');
  await expect(save).toBeEnabled();
  await keyboardSave(page, save);
  await expect
    .poll(() => fs.readFileSync(path.join(repoDir, EDITABLE.alpha), 'utf8'))
    .toContain('// via-key');
});

test('Save keybinding is scoped per card — saving one editor does not save another', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await mountCard(page, EDITABLE.alpha);
  await mountCard(page, EDITABLE.beta);

  const alphaSave = page.locator(`${cardSel(EDITABLE.alpha)} .card-actions button:has-text("Save")`);
  const betaSave = page.locator(`${cardSel(EDITABLE.beta)} .card-actions button:has-text("Save")`);

  // Dirty BOTH editors.
  await page.locator(`${cardSel(EDITABLE.beta)} .monaco-host .view-lines`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // beta-dirty');
  await expect(betaSave).toBeEnabled();

  await page.locator(`${cardSel(EDITABLE.alpha)} .monaco-host .view-lines`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // alpha-scope');
  await expect(alphaSave).toBeEnabled();

  const betaBefore = fs.readFileSync(path.join(repoDir, EDITABLE.beta), 'utf8');

  // Save while ALPHA is focused. A global keybinding (the old bug) would steal
  // this and/or leave beta unsaved-but-mismatched; the per-editor addAction
  // must save only alpha.
  await keyboardSave(page, alphaSave);

  // Alpha persisted; beta did NOT (still dirty, disk unchanged).
  await expect
    .poll(() => fs.readFileSync(path.join(repoDir, EDITABLE.alpha), 'utf8'))
    .toContain('// alpha-scope');
  await expect(betaSave).toBeEnabled();
  expect(fs.readFileSync(path.join(repoDir, EDITABLE.beta), 'utf8')).toBe(betaBefore);
  expect(betaBefore).not.toContain('// beta-dirty');
});

test('re-render disposes editors with no leaked Monaco models', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');

  const editableCode = [
    EDITABLE.small,
    EDITABLE.large,
    EDITABLE.tall,
    EDITABLE.alpha,
    EDITABLE.beta,
  ];
  const mountAll = async () => {
    for (const p of editableCode) await mountCard(page, p);
    // Let any late model creation settle.
    await page.waitForTimeout(300);
    return page.evaluate(() => window.monaco.editor.getModels().length);
  };

  const first = await mountAll();
  // At least one original + one modified model per explicitly mounted card.
  // (Adjacent read-only cards, e.g. the deleted file, may also lazy-mount when
  // scrolled near, so assert a lower bound rather than an exact count.)
  expect(first).toBeGreaterThanOrEqual(editableCode.length * 2);

  // Trigger a full re-render (Refresh -> loadSession -> disposeEditors).
  await page.click('#refreshBtn');
  await page.waitForSelector('.filecard');

  const second = await mountAll();
  // No leak: mounting the same set after disposal yields the SAME live-model
  // count, not a growing one. (Note: the bundled Monaco's getDiffEditors()
  // retains disposed wrapper refs, so we assert on inner models, not wrappers.)
  expect(second).toBe(first);
});

test('binary file shows the binary banner and no Monaco', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await page.click(`li[data-path="${EDITABLE.binary}"]`);

  await expect(page.locator(`${cardSel(EDITABLE.binary)} .binary`)).toBeVisible();
  await expect(page.locator(`${cardSel(EDITABLE.binary)} .monaco-diff-editor`)).toHaveCount(0);
});

test('deleted file renders a read-only Monaco editor with no Save button', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  await page.click(`li[data-path="${EDITABLE.deleted}"]`);
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center' });
  }, cardSel(EDITABLE.deleted));

  // Deletions render in Monaco too (original vs empty), but read-only so a save
  // can't accidentally un-delete the file.
  await page.waitForSelector(`${cardSel(EDITABLE.deleted)} .monaco-diff-editor`, { timeout: 20_000 });
  await expect(page.locator(`${cardSel(EDITABLE.deleted)} .monaco-diff-editor`)).toBeVisible();
  await expect(page.locator(`${cardSel(EDITABLE.deleted)} .card-actions button:has-text("Save")`)).toHaveCount(0);
});

test('deleted lines are selectable and open no Monaco context menu', async ({ page }) => {
  await page.goto(server.baseURL);
  await page.waitForSelector('.filecard');
  // small.js drops its baseline "return a + b;" line, so the inline diff renders
  // a deleted view zone (.line-delete). Monaco normally pops a "Copy deleted
  // lines / Revert this change" menu and preventDefaults selection there; the
  // app suppresses that (app.js) and lifts + re-enables selection (style.css) so
  // deleted lines select/copy natively like added lines.
  await mountCard(page, EDITABLE.small);

  const deleted = page.locator(`${cardSel(EDITABLE.small)} .view-lines.line-delete`).first();
  await expect(deleted).toBeVisible();
  // Sticky card headers overlay the top of the diff and would intercept the
  // pointer; disable their pointer events so events reach the editor.
  await page.addStyleTag({ content: '.filecard-head{pointer-events:none!important}' });
  await deleted.scrollIntoViewIfNeeded();
  const box = await deleted.boundingBox();
  const y = box.y + box.height / 2;

  // A real drag across the deleted line selects its text natively.
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(box.width - 4, 40), y, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  // Monaco may render spaces as non-breaking; normalize before matching.
  expect(selected.replace(/\u00a0/g, ' ')).toContain('return a + b;');

  // Clicking the deleted line opens no context menu (Monaco renders it as
  // .monaco-menu with these actions).
  await page.mouse.click(box.x + box.width / 2, y);
  await expect(page.locator('.monaco-menu')).toHaveCount(0);
  await expect(page.getByText('Copy deleted lines', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Revert this change', { exact: false })).toHaveCount(0);
});
