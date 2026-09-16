# git diffui

A GitHub-style **web UI for `git diff`** that lets you **edit the working-tree file**
right in the browser — no VS Code, no diff-between-two-temp-files.

Ships as a **single static Go binary** with the web UI embedded via `//go:embed`
(no Node, no runtime assets to ship). The backend shells out to your existing `git`.

- **All diffs in one scrollable window**, like a GitHub PR "Files changed" view.
- **Editable working tree**: in editable views the "after" side is your real file —
  edit it in the browser, hit save, and it's written straight to disk with the diff
  re-computed live.
- **Per-repo history**: every launch is recorded, so you can reopen past diffs
  (great for commit ranges).
- **Runs as a git subcommand**: `git diffui`.

## Build & install

Requires Go 1.24+ and `git` on your PATH.

```bash
make install        # go install . -> $GOBIN (usually ~/go/bin)
# ensure that dir is on your PATH, then `git diffui` works anywhere

# or drop a binary into ~/.local/bin:
make install-local

# or just build locally:
make build          # -> ./git-diffui
```

For `git diffui` to work, the binary must be named `git-diffui` and be on your PATH
(git resolves `git <x>` to `git-<x>`). Both install targets satisfy that.

## Usage

Run inside any git repo:

| Command | Shows | Mode |
|---|---|---|
| `git diffui` | Uncommitted changes (`HEAD` → working tree) | **editable** |
| `git diffui --staged` | Staged changes (`HEAD` → index) | read-only |
| `git diffui <commit>` | `<commit>` → working tree | **editable** |
| `git diffui <a> <b>` | `<a>` → `<b>` (historical) | read-only |
| `git diffui <a>..<b>` | Range between two commits | read-only |

Options: `-p/--port <n>`, `--host <h>`, `--no-open`, `--staged` (`--cached`), `-h`.

> Note: git intercepts `git diffui --help` to look for a man page. Use `git diffui -h`
> or `git-diffui -h` for the built-in help.

## In the browser

- **Sidebar**: file list with status + `+/-` counts; click to jump to a file.
- **Inline editing** (editable views): syntax-highlighted Monaco diffs load as
  cards approach the viewport, without an Edit button. Small diffs show at full
  height; large unchanged gaps collapse with clickable expanders. Cards taller
  than 600px have an **Expand / Collapse** toggle.
  **Save** enables when you edit; `⌘S` / `Ctrl+S` saves to disk and re-diffs.
  Deleted files and read-only comparisons use textual diff tables.
- **Compare…**: diff any two revisions (or one commit vs your working tree).
- **History**: reopen any past diff for this repo.

## Testing

```bash
make test           # go test ./...
make cover          # with coverage
go test -run TestAPIEditFlow -v ./...   # a single test
```

The suite covers the git plumbing (against real temporary repos), the pure
helpers (`parseArgs`, `computeEditable`, `labelFor`, history dedup), and the HTTP
API end-to-end via `httptest` (session, diff, edit-to-disk, read-only guards,
switch/compare, history, embedded static serving). Tests that need `git` skip
automatically if it isn't installed.

### Frontend tests

The inline-Monaco UI has a hermetic browser (E2E) suite driven by
[Playwright](https://playwright.dev/) (bundled Chromium), living in
`test/e2e/`. Each run spins up a temporary git repo with fixtures, launches the
built `git-diffui` binary headlessly, and drives the real UI.

```bash
npx playwright install chromium   # one-time: download the browser (~150 MB)
make test-e2e                     # build the binary + run the Playwright suite
```

`make test-e2e` is intentionally **not** part of `make test` / `go test`, so
contributors without the Playwright browser aren't blocked. It installs npm
dependencies on first run and requires the one-time `playwright install`
above (network access needed once).

Coverage:

- Editable non-binary cards auto-mount an inline Monaco diff editor (no "Edit"
  button), with live syntax highlighting.
- Small files render uncapped; a tall single change is capped at ~600px with a
  working Expand/Collapse toggle.
- Large multi-hunk files hide unchanged regions and expand on demand.
- Editing enables Save; both the Save button and the ⌘/Ctrl+S keybinding persist
  to disk and update the add/delete counts, and the keybinding is scoped
  per-card (saving one editor never touches another).
- Re-rendering disposes editors with no leaked Monaco models.
- Binary files show the binary banner, deleted files fall back to a textual diff
  table, and read-only specs (e.g. `--staged`) refuse inline editing — all with
  no Monaco.

## Project layout

```
main.go          CLI parsing (parseArgs), embed, server bootstrap
git.go           git plumbing: name-status/numstat parsing, per-file diff, safe file I/O
server.go        HTTP handlers + session state (computeEditable, labelFor)
history.go       per-repo history persistence
public/          vanilla-JS single-page UI (embedded into the binary)
*_test.go        test suite
```

### HTTP API

- `GET /api/session` — current diff: repo, editable flag, label, file list.
- `GET /api/diff?path=…` — unified diff text for one file.
- `GET /api/file?path=…` — working-file content (editable views only).
- `POST /api/file` `{path, content}` — write file to disk, return re-diff + counts.
- `POST /api/switch` `{spec:[…]}` — change the diff spec (validated); returns a session.
- `GET /api/history` — past diffs for this repo.

## Safety

- Binds to `127.0.0.1` only.
- File writes are restricted to inside the repo (path-traversal guarded).
- Editing is only enabled when the diff's target is your working tree; historical and
  staged diffs are read-only.

## Limitations (v1)

- Untracked files aren't shown (matches `git diff`); stage or add them to see them.
- Unified diff view only (no split view yet).
- Binary files are listed but not rendered.
