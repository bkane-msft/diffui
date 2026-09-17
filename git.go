package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// EmptyTree is git's canonical empty tree object, used as a base when HEAD does
// not exist yet (a repo with no commits).
const EmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// FileEntry describes one changed file in a diff.
type FileEntry struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
}

// gitOutput runs git in the given dir and returns stdout, or an error carrying
// stderr for diagnostics.
func gitOutput(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%s", msg)
	}
	return out.Bytes(), nil
}

func gitText(dir string, args ...string) (string, error) {
	b, err := gitOutput(dir, args...)
	return string(b), err
}

// gitDiffOutput runs a git diff-family command, tolerating exit code 1 (which
// diff uses to signal "differences found") and returning stdout in that case.
func gitDiffOutput(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return out.Bytes(), nil
		}
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%s", msg)
	}
	return out.Bytes(), nil
}

// isUntracked reports whether file exists in the working tree but is not tracked
// in the index (a brand-new file that `git diff` would otherwise ignore).
func isUntracked(dir, file string) bool {
	_, err := gitOutput(dir, "ls-files", "--error-unmatch", "--", file)
	return err != nil
}

func repoRoot(dir string) (string, error) {
	s, err := gitText(dir, "rev-parse", "--show-toplevel")
	return strings.TrimSpace(s), err
}

func gitDir(dir string) (string, error) {
	s, err := gitText(dir, "rev-parse", "--absolute-git-dir")
	return strings.TrimSpace(s), err
}

func hasHead(dir string) bool {
	_, err := gitOutput(dir, "rev-parse", "--verify", "--quiet", "HEAD")
	return err == nil
}

// effectiveSpec swaps HEAD for the empty tree when the repo has no commits, so
// the default "uncommitted changes" view still works in a brand-new repo.
func effectiveSpec(spec []string, dir string) []string {
	if hasHead(dir) {
		return spec
	}
	out := make([]string, len(spec))
	for i, a := range spec {
		if a == "HEAD" {
			out[i] = EmptyTree
		} else {
			out[i] = a
		}
	}
	return out
}

func splitNul(b []byte) []string {
	parts := bytes.Split(b, []byte{0})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, string(p))
	}
	return out
}

// nameStatus parses `git diff --name-status -z` with rename detection.
func nameStatus(spec []string, dir string) ([]FileEntry, error) {
	args := append([]string{"diff", "--name-status", "--find-renames", "-z"}, spec...)
	b, err := gitOutput(dir, args...)
	if err != nil {
		return nil, err
	}
	toks := []string{}
	for _, t := range splitNul(b) {
		if t != "" {
			toks = append(toks, t)
		}
	}
	files := []FileEntry{}
	for i := 0; i < len(toks); {
		status := toks[i]
		i++
		if len(status) == 0 {
			continue
		}
		code := string(status[0])
		if code == "R" || code == "C" {
			if i+1 >= len(toks) {
				break
			}
			oldPath := toks[i]
			newPath := toks[i+1]
			i += 2
			files = append(files, FileEntry{Status: code, Path: newPath, OldPath: oldPath})
		} else {
			if i >= len(toks) {
				break
			}
			p := toks[i]
			i++
			files = append(files, FileEntry{Status: code, Path: p})
		}
	}
	return files, nil
}

type counts struct {
	additions int
	deletions int
	binary    bool
}

// numstat parses `git diff --numstat -z`, keyed by (new) path.
func numstat(spec []string, dir string) (map[string]counts, error) {
	args := append([]string{"diff", "--numstat", "-z"}, spec...)
	b, err := gitOutput(dir, args...)
	if err != nil {
		return nil, err
	}
	toks := splitNul(b)
	m := map[string]counts{}
	for i := 0; i < len(toks); {
		tok := toks[i]
		i++
		if tok == "" {
			continue
		}
		parts := strings.SplitN(tok, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		add, del, p := parts[0], parts[1], parts[2]
		if p == "" {
			// rename/copy: next two tokens are old, new
			if i+1 <= len(toks) {
				i++ // old path
			}
			if i < len(toks) {
				p = toks[i]
				i++
			}
		}
		binary := add == "-" && del == "-"
		c := counts{binary: binary}
		if !binary {
			c.additions, _ = strconv.Atoi(add)
			c.deletions, _ = strconv.Atoi(del)
		}
		m[p] = c
	}
	return m, nil
}

// untrackedFiles lists working-tree files git is not tracking (respecting
// .gitignore), as new-file (status "A") entries with add/binary counts computed
// from disk. `git diff` omits these, so they are folded in for working-tree views.
func untrackedFiles(dir string) ([]FileEntry, error) {
	b, err := gitOutput(dir, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	entries := []FileEntry{}
	for _, p := range splitNul(b) {
		if p == "" {
			continue
		}
		e := FileEntry{Status: "A", Path: p}
		if data, rerr := readWorkingFile(dir, p); rerr == nil {
			if bytes.IndexByte([]byte(data), 0) >= 0 {
				e.Binary = true
			} else {
				e.Additions = lineCount(data)
			}
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// lineCount reports the number of lines in s, matching git's diff accounting for
// a newly added file (a final line without a trailing newline still counts).
func lineCount(s string) int {
	if s == "" {
		return 0
	}
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

func fileList(spec []string, dir string) ([]FileEntry, error) {
	eff := effectiveSpec(spec, dir)
	statuses, err := nameStatus(eff, dir)
	if err != nil {
		return nil, err
	}
	cnts, err := numstat(eff, dir)
	if err != nil {
		return nil, err
	}
	for i := range statuses {
		if c, ok := cnts[statuses[i].Path]; ok {
			statuses[i].Additions = c.additions
			statuses[i].Deletions = c.deletions
			statuses[i].Binary = c.binary
		}
	}
	// Working-tree views also surface brand-new (untracked) files, which
	// `git diff` never reports.
	if _, _, targetWorking := diffSides(spec); targetWorking {
		untracked, uerr := untrackedFiles(dir)
		if uerr != nil {
			return nil, uerr
		}
		statuses = append(statuses, untracked...)
	}
	return statuses, nil
}

func fileDiff(spec []string, file, dir string) (string, error) {
	eff := effectiveSpec(spec, dir)
	// Untracked files never appear in `git diff`; diff them against nothing so
	// working-tree views show (and count) their contents as all-additions.
	if _, _, targetWorking := diffSides(spec); targetWorking && isUntracked(dir, file) {
		out, err := gitDiffOutput(dir, "diff", "--no-color", "--no-index", "--", os.DevNull, file)
		return string(out), err
	}
	args := append([]string{"diff", "--no-color"}, eff...)
	args = append(args, "--", file)
	return gitText(dir, args...)
}

// resolveInRepo guards against path traversal outside the repository root.
func resolveInRepo(root, rel string) (string, error) {
	full := filepath.Clean(filepath.Join(root, rel))
	if full != root && !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes repository: %s", rel)
	}
	return full, nil
}

// baseRevForSpec returns the revision forming the base (left) side of the diff,
// or "" to mean the index. Flags are skipped; the first revision wins.
func baseRevForSpec(spec []string) string {
	for _, a := range spec {
		if strings.HasPrefix(a, "-") {
			continue
		}
		return a
	}
	return ""
}

// readBaseFile returns the base-side (original) content of a file for the given
// diff spec, using `git show <rev>:<path>` (or `:<path>` for the index). If the
// file does not exist on the base side (e.g. a newly added file, or an empty
// tree in a repo with no commits), it returns an empty string with no error.
func readBaseFile(spec []string, rel, dir string) (string, error) {
	if _, err := resolveInRepo(dir, rel); err != nil {
		return "", err
	}
	ref := ":" + rel
	if base := baseRevForSpec(spec); base != "" {
		ref = base + ":" + rel
	}
	out, err := gitOutput(dir, "show", ref)
	if err != nil {
		// Not present on the base side -> treat as empty (added file).
		return "", nil
	}
	return string(out), nil
}

// diffSides resolves the base (left) and target (right) sides of a diff spec for
// content reads. baseRev and targetRev are git revisions to feed `git show
// <rev>:<path>`; an empty string means the index (":<path>"). When targetWorking
// is true the target side is the working tree on disk rather than a revision.
func diffSides(spec []string) (baseRev, targetRev string, targetWorking bool) {
	staged := false
	revs := []string{}
	for _, a := range spec {
		switch {
		case a == "--cached" || a == "--staged":
			staged = true
		case strings.HasPrefix(a, "-"):
			// other flags don't select a side
		default:
			revs = append(revs, a)
		}
	}
	if staged {
		// git diff --cached: HEAD -> index.
		return "HEAD", "", false
	}
	switch len(revs) {
	case 0:
		// git diff: index -> working tree.
		return "", "", true
	case 1:
		r := revs[0]
		if strings.Contains(r, "..") {
			sep := ".."
			if strings.Contains(r, "...") {
				sep = "..."
			}
			parts := strings.SplitN(r, sep, 2)
			a, b := parts[0], ""
			if len(parts) > 1 {
				b = parts[1]
			}
			if a == "" {
				a = "HEAD"
			}
			if b == "" {
				b = "HEAD"
			}
			return a, b, false
		}
		// single rev: rev -> working tree.
		return r, "", true
	default:
		return revs[0], revs[1], false
	}
}

// showFile returns a file's content at a git revision. An empty rev reads the
// index (":<path>"). A file missing on that side (added or deleted) yields an
// empty string and no error, so the caller can render it as an add/delete.
func showFile(dir, rev, rel string) (string, error) {
	if _, err := resolveInRepo(dir, rel); err != nil {
		return "", err
	}
	ref := ":" + rel
	if rev != "" {
		ref = rev + ":" + rel
	}
	out, err := gitOutput(dir, "show", ref)
	if err != nil {
		return "", nil
	}
	return string(out), nil
}

// fileSides returns the base (original) and target (modified) content for a file
// under a diff spec, ready to feed the inline diff editor for any spec —
// editable (working tree) or read-only (staged, two-revision, or range).
func fileSides(spec []string, rel, dir string) (base, content string, err error) {
	baseRev, targetRev, targetWorking := diffSides(spec)
	if base, err = showFile(dir, baseRev, rel); err != nil {
		return "", "", err
	}
	if targetWorking {
		content, err = readWorkingFile(dir, rel)
		if err != nil {
			if os.IsNotExist(err) {
				// Deleted in the working tree -> empty target side.
				return base, "", nil
			}
			return "", "", err
		}
		return base, content, nil
	}
	if content, err = showFile(dir, targetRev, rel); err != nil {
		return "", "", err
	}
	return base, content, nil
}

func readWorkingFile(root, rel string) (string, error) {
	full, err := resolveInRepo(root, rel)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(full)
	return string(b), err
}

func writeWorkingFile(root, rel, content string) error {
	full, err := resolveInRepo(root, rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(content), 0o644)
}

// countDiff tallies +/- lines from a unified diff (excluding file headers).
func countDiff(diff string) (int, int) {
	add, del := 0, 0
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
			continue
		case strings.HasPrefix(line, "+"):
			add++
		case strings.HasPrefix(line, "-"):
			del++
		}
	}
	return add, del
}
