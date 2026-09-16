package main

import (
	"io/fs"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// readAsset returns an embedded public asset's contents.
func readAsset(t *testing.T, name string) string {
	t.Helper()
	assets, err := fs.Sub(embedded, "public")
	require.NoError(t, err)
	b, err := fs.ReadFile(assets, name)
	require.NoErrorf(t, err, "read %s", name)
	return string(b)
}

// The `hidden` attribute must stay authoritative; otherwise a `display:` rule
// (e.g. .modal-backdrop{display:flex}) leaves an empty modal visible on load.
func TestCSSHiddenGuard(t *testing.T) {
	css := readAsset(t, "style.css")
	assert.Contains(t, css, "[hidden]")
	assert.Contains(t, css, "display: none !important")
}

// HTML does not interpret JS-style \uXXXX escapes; they'd render literally.
func TestHTMLNoLiteralUnicodeEscapes(t *testing.T) {
	html := readAsset(t, "index.html")
	assert.NotContains(t, html, `\u`, "index.html has a literal \\u escape")
}
