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

## Shell completion

Make `git diffui <TAB>` complete branches, tags, and commits (including
`a..b` ranges) plus the flags above — just like `git diff <TAB>`. The
completion scripts are **embedded in the binary** and reuse git's own
ref-completion helpers, so git's completion must be loaded first (it usually
is).

The easiest way is the built-in `completion` subcommand, which prints the
script for your shell to stdout:

**bash** — source it from `~/.bashrc`, after git's completion:

```bash
source <(git diffui completion bash)
```

**zsh** — save it on your `$fpath` as `_git_diffui`, then run `compinit`:

```zsh
# ~/fbin here is any directory on your $fpath (check: print -l $fpath)
git diffui completion zsh > ~/fbin/_git_diffui
autoload -Uz compinit && compinit
```

The filename **`_git_diffui`** (underscores, no dash) matters: git's own zsh
completion dispatches the `git diffui` subcommand to a function named
`_git_diffui`, so a file named `_git-diffui` would be silently ignored and
`git diffui <TAB>` would fall back to filenames.

If you'd rather not edit your rc files by hand, `make install-completions`
saves the zsh completion onto `~/fbin` (override with
`ZSH_COMPLETIONS_DIR=…`) and prints the bash setup line for you. Point
`ZSH_COMPLETIONS_DIR` at a directory that's already on your `$fpath` (check
with `print -l $fpath`), otherwise zsh won't pick the file up.

The raw scripts also live in [`completions/`](completions/) if you want to
source them directly. Both cover the `git diffui` subcommand form and the
standalone `git-diffui` binary; see the header comment in each file for
details.

> Packaging with Homebrew? The `completion` subcommand plugs straight into
> `generate_completions_from_executable(bin/"git-diffui", "completion")`.

## In the browser

- **Sidebar**: file list with status + `+/-` counts; click to jump to a file.
  Shown on the right-hand side of the layout, collapsed by default — toggle it
  with the **Files** button in the top bar (your choice is remembered).
- **Diffs render in Monaco** for every view — syntax-highlighted, consistent UI.
  Editors mount lazily as cards approach the viewport, without an Edit button.
  Files render inline at full height; large unchanged gaps collapse with
  clickable expanders so you can scroll through the whole file.
- **Collapse a file**: the caret in each file card's header collapses/expands
  that card's body so you can skip past large files without scrolling.
- **Inline editing** (editable views only): **Save** enables when you edit;
  `⌘S` / `Ctrl+S` saves to disk and re-diffs. Read-only comparisons (historical,
  `--staged`, ranges) and deleted files render the same Monaco diff but read-only
  — no Save, no writes.
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
- Files render full height inline with no snippet Expand/Collapse cap.
- The file list is collapsed by default; the **Files** button toggles it and the
  choice persists.
- The per-card header caret collapses and restores a file's body.
- Large multi-hunk files hide unchanged regions and expand on demand.
- Editing enables Save; both the Save button and the ⌘/Ctrl+S keybinding persist
  to disk and update the add/delete counts, and the keybinding is scoped
  per-card (saving one editor never touches another).
- Re-rendering disposes editors with no leaked Monaco models.
- Binary files show the binary banner (no Monaco). Deleted files and read-only
  specs (e.g. `--staged`) render a read-only Monaco diff — syntax-highlighted but
  with no Save button and writes refused by the API.

## Project layout

```
main.go          CLI parsing (parseArgs), embed, server bootstrap
git.go           git plumbing: name-status/numstat parsing, per-file diff, safe file I/O
server.go        HTTP handlers + session state (computeEditable, labelFor)
history.go       per-repo history persistence
public/          vanilla-JS single-page UI (embedded into the binary)
completions/     bash + zsh shell completion for `git diffui`
*_test.go        test suite
```

### HTTP API

- `GET /api/session` — current diff: repo, editable flag, label, file list.
- `GET /api/diff?path=…` — unified diff text for one file.
- `GET /api/file?path=…` — original + working/target content for a file, plus the
  `editable` flag. Served for any spec so read-only diffs render in Monaco too.
- `POST /api/file` `{path, content}` — write file to disk, return re-diff + counts.
  Rejected with `403` on read-only diffs.
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
