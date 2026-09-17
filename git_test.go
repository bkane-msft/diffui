package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFileListAndCounts(t *testing.T) {
	dir := newTestRepo(t)
	files, err := fileList([]string{"HEAD"}, dir)
	require.NoError(t, err)
	require.Len(t, files, 2)

	a := findFile(files, "a.txt")
	require.NotNil(t, a)
	assert.Equal(t, "M", a.Status)
	assert.Equal(t, 2, a.Additions)
	assert.Equal(t, 1, a.Deletions)

	c := findFile(files, "c.txt")
	require.NotNil(t, c)
	assert.Equal(t, "A", c.Status)
}

func TestFileListIncludesUntracked(t *testing.T) {
	dir := newTestRepo(t)
	// A brand-new file that has never been `git add`ed.
	writeFile(t, dir, "untracked.txt", "one\ntwo\nthree\n")

	// Working-tree view surfaces it as an added file with add counts.
	files, err := fileList([]string{"HEAD"}, dir)
	require.NoError(t, err)
	u := findFile(files, "untracked.txt")
	require.NotNil(t, u, "expected untracked.txt in %+v", files)
	assert.Equal(t, "A", u.Status)
	assert.Equal(t, 3, u.Additions)
	assert.Equal(t, 0, u.Deletions)
	assert.False(t, u.Binary)

	// Its diff renders as all-additions even though `git diff` ignores it.
	diff, err := fileDiff([]string{"HEAD"}, "untracked.txt", dir)
	require.NoError(t, err)
	assert.Contains(t, diff, "+one")
	assert.Contains(t, diff, "+three")

	// Read-only views (e.g. --cached) do not surface untracked files.
	staged, err := fileList([]string{"--cached"}, dir)
	require.NoError(t, err)
	assert.Nil(t, findFile(staged, "untracked.txt"), "untracked leaked into --cached view")
}

func TestUntrackedFileHonorsGitignore(t *testing.T) {
	dir := newTestRepo(t)
	writeFile(t, dir, ".gitignore", "ignored.log\n")
	writeFile(t, dir, "ignored.log", "noise\n")
	writeFile(t, dir, "shown.txt", "kept\n")

	files, err := fileList([]string{"HEAD"}, dir)
	require.NoError(t, err)
	assert.NotNil(t, findFile(files, "shown.txt"))
	assert.Nil(t, findFile(files, "ignored.log"), "ignored file should not appear")
}

func TestFileDiffContainsChange(t *testing.T) {
	dir := newTestRepo(t)
	diff, err := fileDiff([]string{"HEAD"}, "a.txt", dir)
	require.NoError(t, err)
	assert.Contains(t, diff, "+line2 CHANGED")
	assert.Contains(t, diff, "-line2")
}

func TestRenameDetection(t *testing.T) {
	dir := newTestRepo(t)
	mustGit(t, dir, "commit", "-qam", "second")
	mustGit(t, dir, "mv", "b.txt", "b-renamed.txt")

	files, err := fileList([]string{"HEAD"}, dir)
	require.NoError(t, err)
	r := findFile(files, "b-renamed.txt")
	require.NotNil(t, r, "expected rename entry in %+v", files)
	assert.Equal(t, "R", r.Status)
	assert.Equal(t, "b.txt", r.OldPath)
}

func TestEffectiveSpecNoHead(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q")
	mustGit(t, dir, "config", "user.email", "t@t.co")
	mustGit(t, dir, "config", "user.name", "t")
	writeFile(t, dir, "new.txt", "hi\n")
	mustGit(t, dir, "add", "new.txt")

	require.False(t, hasHead(dir), "fresh repo should have no HEAD")
	assert.Equal(t, []string{EmptyTree}, effectiveSpec([]string{"HEAD"}, dir))

	files, err := fileList([]string{"HEAD"}, dir)
	require.NoError(t, err)
	assert.NotNil(t, findFile(files, "new.txt"), "expected new.txt in %+v", files)
}

func TestResolveInRepoGuard(t *testing.T) {
	root := "/tmp/repo"
	_, err := resolveInRepo(root, "../etc/passwd")
	assert.Error(t, err, "traversal should be rejected")

	_, err = resolveInRepo(root, "sub/ok.txt")
	assert.NoError(t, err)
}

func TestReadWriteRoundTrip(t *testing.T) {
	dir := newTestRepo(t)
	require.NoError(t, writeWorkingFile(dir, "a.txt", "only one line\n"))
	got, err := readWorkingFile(dir, "a.txt")
	require.NoError(t, err)
	assert.Equal(t, "only one line\n", got)
}

func TestCountDiff(t *testing.T) {
	diff := "diff --git a/x w/x\n--- a/x\n+++ w/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n"
	add, del := countDiff(diff)
	assert.Equal(t, 2, add)
	assert.Equal(t, 1, del)
}

func TestBaseRevForSpec(t *testing.T) {
	assert.Equal(t, "", baseRevForSpec([]string{}))
	assert.Equal(t, "", baseRevForSpec([]string{"--cached"}))
	assert.Equal(t, "HEAD", baseRevForSpec([]string{"HEAD"}))
	assert.Equal(t, "HEAD", baseRevForSpec([]string{"--stat", "HEAD"}))
	assert.Equal(t, "a", baseRevForSpec([]string{"a", "b"}))
}

func TestReadBaseFile(t *testing.T) {
	dir := newTestRepo(t)

	// Modified file: base is the committed HEAD version.
	base, err := readBaseFile([]string{"HEAD"}, "a.txt", dir)
	require.NoError(t, err)
	assert.Equal(t, "line1\nline2\nline3\n", base)

	// Added file absent from HEAD: empty base, no error.
	base, err = readBaseFile([]string{"HEAD"}, "c.txt", dir)
	require.NoError(t, err)
	assert.Equal(t, "", base)

	// Path traversal is rejected.
	_, err = readBaseFile([]string{"HEAD"}, "../escape", dir)
	assert.Error(t, err)
}
