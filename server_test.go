package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestComputeEditable(t *testing.T) {
	cases := []struct {
		spec []string
		want bool
	}{
		{[]string{"HEAD"}, true},
		{[]string{}, true},
		{[]string{"abc123"}, true},
		{[]string{"--cached"}, false},
		{[]string{"--staged"}, false},
		{[]string{"a", "b"}, false},
		{[]string{"a..b"}, false},
		{[]string{"a...b"}, false},
	}
	for _, c := range cases {
		assert.Equalf(t, c.want, computeEditable(c.spec), "computeEditable(%v)", c.spec)
	}
}

func TestLabelFor(t *testing.T) {
	assert.Equal(t, "Working tree", labelFor([]string{"HEAD"}).Target)
	assert.Contains(t, labelFor([]string{"--cached"}).Text, "Staged")

	two := labelFor([]string{"a", "b"})
	assert.Equal(t, "a", two.Base)
	assert.Equal(t, "b", two.Target)

	rng := labelFor([]string{"x..y"})
	assert.Equal(t, "x", rng.Base)
	assert.Equal(t, "y", rng.Target)
}

func newTestServer(t *testing.T, dir string, spec []string) *DifuiServer {
	t.Helper()
	historyPath := filepath.Join(t.TempDir(), "history.json")
	return NewDifuiServer(dir, historyPath, spec, fstest.MapFS{})
}

func doJSON(t *testing.T, h http.Handler, method, url string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, url, r)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestAPISession(t *testing.T) {
	dir := newTestRepo(t)
	h := newTestServer(t, dir, []string{"HEAD"}).Handler()
	rec, out := doJSON(t, h, "GET", "/api/session", nil)
	require.Equal(t, 200, rec.Code)
	assert.Equal(t, true, out["editable"])
	files, _ := out["files"].([]any)
	assert.Len(t, files, 2)
}

func TestAPIEditFlow(t *testing.T) {
	dir := newTestRepo(t)
	h := newTestServer(t, dir, []string{"HEAD"}).Handler()

	rec, out := doJSON(t, h, "GET", "/api/file?path=a.txt", nil)
	require.Equalf(t, 200, rec.Code, "get file: %v", out)
	assert.Contains(t, out["content"].(string), "line2 CHANGED")
	assert.Equal(t, "line1\nline2\nline3\n", out["base"], "base should be the HEAD version")

	rec, out = doJSON(t, h, "POST", "/api/file", map[string]string{
		"path":    "a.txt",
		"content": "just one line\n",
	})
	require.Equalf(t, 200, rec.Code, "post file: %v", out)
	assert.Equal(t, true, out["ok"])

	got, err := readWorkingFile(dir, "a.txt")
	require.NoError(t, err)
	assert.Equal(t, "just one line\n", got)
}

func TestAPIReadOnlyRejectsEdit(t *testing.T) {
	dir := newTestRepo(t)
	h := newTestServer(t, dir, []string{"--cached"}).Handler()

	rec, _ := doJSON(t, h, "GET", "/api/file?path=c.txt", nil)
	assert.Equal(t, 403, rec.Code, "read-only file read should be forbidden")

	rec, _ = doJSON(t, h, "POST", "/api/file", map[string]string{"path": "c.txt", "content": "x"})
	assert.Equal(t, 403, rec.Code, "read-only file write should be forbidden")
}

func TestAPISwitchAndEditableRecompute(t *testing.T) {
	dir := newTestRepo(t)
	h := newTestServer(t, dir, []string{"HEAD"}).Handler()

	sha := headSHA(t, dir)
	rec, out := doJSON(t, h, "POST", "/api/switch", map[string]any{"spec": []string{EmptyTree, sha}})
	require.Equalf(t, 200, rec.Code, "switch: %v", out)
	assert.Equal(t, false, out["editable"], "two-rev diff should be read-only")

	rec, _ = doJSON(t, h, "POST", "/api/switch", map[string]any{"spec": []string{"definitely-not-a-ref"}})
	assert.Equal(t, 400, rec.Code, "invalid spec should be rejected")
}

func TestAPIHistory(t *testing.T) {
	dir := newTestRepo(t)
	h := newTestServer(t, dir, []string{"HEAD"}).Handler()

	sha := headSHA(t, dir)
	doJSON(t, h, "POST", "/api/switch", map[string]any{"spec": []string{EmptyTree, sha}})

	rec, out := doJSON(t, h, "GET", "/api/history", nil)
	require.Equal(t, 200, rec.Code)
	entries, _ := out["entries"].([]any)
	assert.GreaterOrEqual(t, len(entries), 2)
}

func TestStaticAssetsServed(t *testing.T) {
	dir := newTestRepo(t)
	historyPath := filepath.Join(t.TempDir(), "history.json")
	assets := fstest.MapFS{"index.html": {Data: []byte("<html>diffui</html>")}}
	h := NewDifuiServer(dir, historyPath, []string{"HEAD"}, assets).Handler()

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, 200, rec.Code)
	assert.Contains(t, rec.Body.String(), "diffui")
}
