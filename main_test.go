package main

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseArgs(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want options
	}{
		{"default", nil, options{port: 4300, host: "127.0.0.1", open: true, spec: []string{"HEAD"}}},
		{"staged", []string{"--staged"}, options{port: 4300, host: "127.0.0.1", open: true, spec: []string{"--cached"}}},
		{"cached alias", []string{"--cached"}, options{port: 4300, host: "127.0.0.1", open: true, spec: []string{"--cached"}}},
		{"one rev", []string{"abc"}, options{port: 4300, host: "127.0.0.1", open: true, spec: []string{"abc"}}},
		{"two revs", []string{"a", "b"}, options{port: 4300, host: "127.0.0.1", open: true, spec: []string{"a", "b"}}},
		{"port + no-open", []string{"-p", "5000", "--no-open"}, options{port: 5000, host: "127.0.0.1", open: false, spec: []string{"HEAD"}}},
		{"port equals", []string{"--port=6001"}, options{port: 6001, host: "127.0.0.1", open: true, spec: []string{"HEAD"}}},
		{"host", []string{"--host", "0.0.0.0"}, options{port: 4300, host: "0.0.0.0", open: true, spec: []string{"HEAD"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseArgs(c.argv)
			require.NoError(t, err)
			assert.Equal(t, c.want, got)
		})
	}
}

func TestParseArgsHelp(t *testing.T) {
	got, err := parseArgs([]string{"-h"})
	require.NoError(t, err)
	assert.True(t, got.help)
}

func TestParseArgsErrors(t *testing.T) {
	_, err := parseArgs([]string{"--port"})
	assert.Error(t, err, "missing port value")

	_, err = parseArgs([]string{"--port", "notanumber"})
	assert.Error(t, err, "non-numeric port")

	_, err = parseArgs([]string{"--host"})
	assert.Error(t, err, "missing host value")
}

func TestHistoryRecordDedup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	recordHistory(path, HistoryEntry{ID: "1", Spec: []string{"HEAD"}, RepoRoot: "/r"})
	recordHistory(path, HistoryEntry{ID: "2", Spec: []string{"a", "b"}, RepoRoot: "/r"})
	recordHistory(path, HistoryEntry{ID: "3", Spec: []string{"HEAD"}, RepoRoot: "/r"}) // dedups #1

	entries := loadHistory(path)
	require.Len(t, entries, 2)
	assert.Equal(t, "3", entries[0].ID, "most recent should be first")
	for _, e := range entries {
		assert.NotEqual(t, "1", e.ID, "duplicate spec entry should be removed")
	}
}
