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
	return statuses, nil
}

func fileDiff(spec []string, file, dir string) (string, error) {
	eff := effectiveSpec(spec, dir)
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
