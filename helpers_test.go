package main

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// mustGit runs a git command in dir and fails the test on error.
func mustGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	require.NoErrorf(t, err, "git %v failed: %s", args, out)
}

// requireGit skips the test if git is not on PATH.
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

// newTestRepo creates a git repo with one commit and then some uncommitted
// changes: a.txt modified, c.txt added (staged). Returns the repo root.
func newTestRepo(t *testing.T) string {
	t.Helper()
	requireGit(t)
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q")
	mustGit(t, dir, "config", "user.email", "t@t.co")
	mustGit(t, dir, "config", "user.name", "t")
	writeFile(t, dir, "a.txt", "line1\nline2\nline3\n")
	writeFile(t, dir, "b.txt", "keep\n")
	mustGit(t, dir, "add", "-A")
	mustGit(t, dir, "commit", "-qm", "init")
	// uncommitted changes
	writeFile(t, dir, "a.txt", "line1\nline2 CHANGED\nline3\nline4 added\n")
	writeFile(t, dir, "c.txt", "brand new\n")
	mustGit(t, dir, "add", "c.txt")
	return dir
}

func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	require.NoErrorf(t, writeWorkingFile(dir, rel, content), "write %s", rel)
}

func headSHA(t *testing.T, dir string) string {
	t.Helper()
	s, err := gitText(dir, "rev-parse", "HEAD")
	require.NoError(t, err)
	return strings.TrimSpace(s)
}

func findFile(files []FileEntry, path string) *FileEntry {
	for i := range files {
		if files[i].Path == path {
			return &files[i]
		}
	}
	return nil
}
