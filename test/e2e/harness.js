'use strict';

// Hermetic test harness for the git-diffui frontend E2E suite.
//
// Responsibilities:
//   * build temporary git repositories with fixtures that exercise every UI
//     branch (inline Monaco, hidden regions, collapse cap, binary, deleted,
//     read-only);
//   * launch the built ./git-diffui binary as a child process against a repo,
//     headless / no browser, and discover the port it actually bound;
//   * poll for readiness and tear everything down cleanly.
//
// No network access is required beyond localhost. The binary must be built
// first (`make build` / `go build -o git-diffui .`); binPath() points at it.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function binPath() {
  const p = path.join(REPO_ROOT, 'git-diffui');
  if (!fs.existsSync(p)) {
    throw new Error(
      'git-diffui binary not found at ' + p + ' — run `make build` first (the ' +
        'make test-e2e target does this for you).'
    );
  }
  return p;
}

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffui-e2e-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'e2e@test.local']);
  git(dir, ['config', 'user.name', 'diffui e2e']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

// Two distinct valid 1x1 PNGs so the binary fixture is genuinely modified.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function repeatLines(prefix, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(prefix + i + ';');
  return out.join('\n') + '\n';
}

// Names of fixtures the editable specs assert against. Exposed so specs don't
// hard-code strings that could drift from the fixtures.
const EDITABLE = {
  small: 'small.js',
  large: 'large.js',
  tall: 'tall.js',
  alpha: 'alpha.js',
  beta: 'beta.js',
  binary: 'image.png',
  deleted: 'gone.txt',
};

// createEditableRepo builds a repo whose default (HEAD -> working tree) diff is
// editable, with one fixture per UI branch. Returns { dir }.
function createEditableRepo() {
  const dir = initRepo();

  // 1) small code file: a few changed lines.
  write(dir, EDITABLE.small, 'function add(a, b) {\n  return a + b;\n}\n');

  // 2) large multi-hunk file: 400+ lines, edits will land near top and bottom
  //    with a big unchanged gap in the middle -> hidden unchanged regions.
  write(dir, EDITABLE.large, repeatLines('const v', 420).replace(/;/g, ' = 0;'));

  // 3) tall file: a long contiguous block that will be fully rewritten so the
  //    rendered inline diff exceeds the 600px collapse cap.
  write(dir, EDITABLE.tall, repeatLines('const old', 90).replace(/;/g, ' = 0;'));

  // 4) small files for the multi-card save-scope test.
  write(dir, EDITABLE.alpha, 'export const alpha = 1;\n');
  write(dir, EDITABLE.beta, 'export const beta = 1;\n');

  // 5) binary fixture (baseline).
  write(dir, EDITABLE.binary, PNG_A);

  // 6) file that will be deleted in the working tree.
  write(dir, EDITABLE.deleted, 'this file will be removed\nsecond line\n');

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'baseline']);

  // ---- uncommitted working-tree edits (make the diff editable) ----

  // small: change one line + append one.
  write(dir, EDITABLE.small, 'function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\n');

  // large: edit near the very top and the very bottom, leaving the middle
  // hundreds of lines untouched.
  {
    const lines = fs
      .readFileSync(path.join(dir, EDITABLE.large), 'utf8')
      .replace(/\n$/, '')
      .split('\n');
    lines[3] = 'const v3 = 99999;';
    lines[lines.length - 2] = 'const v418 = 88888;';
    write(dir, EDITABLE.large, lines.join('\n') + '\n');
  }

  // tall: rewrite every line -> one tall contiguous change.
  write(dir, EDITABLE.tall, repeatLines('const nw', 90).replace(/;/g, ' = 1;'));

  // alpha / beta: change the single line in each.
  write(dir, EDITABLE.alpha, 'export const alpha = 2;\n');
  write(dir, EDITABLE.beta, 'export const beta = 2;\n');

  // binary: swap for a different PNG.
  write(dir, EDITABLE.binary, PNG_B);

  // deleted: remove from working tree (and index) so it diffs as a deletion.
  git(dir, ['rm', '-q', EDITABLE.deleted]);

  return { dir };
}

// createStagedRepo builds a repo with STAGED changes, launched with --staged so
// the diff is read-only (working tree is not the target). Returns { dir }.
function createStagedRepo() {
  const dir = initRepo();
  write(dir, 'ro.js', 'export const value = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'baseline']);
  // Stage a modification (not committed): shows up under --staged.
  write(dir, 'ro.js', 'export const value = 2;\nexport const extra = 3;\n');
  git(dir, ['add', 'ro.js']);
  return { dir };
}

function rmRepo(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

// startServer spawns ./git-diffui in `dir`, discovers the bound port from its
// stdout banner, waits until /api/session responds, and returns a handle.
async function startServer(dir, extraArgs = []) {
  const basePort = 4300 + Math.floor(Math.random() * 4000);
  const args = ['--no-open', '--port', String(basePort), ...extraArgs];
  const child = spawn(binPath(), args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const baseURL = await new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      reject(new Error('timed out waiting for git-diffui banner. stderr:\n' + stderr));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(to);
      reject(new Error('git-diffui exited early (code ' + code + ').\nstderr:\n' + stderr));
    });
    const check = () => {
      const m = /http:\/\/[^\s/]+/.exec(stdout);
      if (m) {
        clearTimeout(to);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', check);
    check();
  });

  // Poll readiness against the real endpoint.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(baseURL + '/api/session');
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('git-diffui did not become ready at ' + baseURL + '\nstderr:\n' + stderr);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    baseURL,
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) return resolve();
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
          resolve();
        }, 2000);
      });
    },
    get stderr() {
      return stderr;
    },
  };
}

module.exports = {
  REPO_ROOT,
  EDITABLE,
  binPath,
  createEditableRepo,
  createStagedRepo,
  rmRepo,
  startServer,
};
