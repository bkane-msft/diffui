package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// HistoryEntry is one recorded launch/switch for a repo.
type HistoryEntry struct {
	ID       string   `json:"id"`
	TS       string   `json:"ts"`
	RepoRoot string   `json:"repoRoot"`
	Spec     []string `json:"spec"`
	Editable bool     `json:"editable"`
	Label    string   `json:"label"`
}

func randID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func loadHistory(path string) []HistoryEntry {
	b, err := os.ReadFile(path)
	if err != nil {
		return []HistoryEntry{}
	}
	var entries []HistoryEntry
	if json.Unmarshal(b, &entries) != nil {
		return []HistoryEntry{}
	}
	return entries
}

func saveHistory(path string, entries []HistoryEntry) {
	if len(entries) > 200 {
		entries = entries[:200]
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	if b, err := json.MarshalIndent(entries, "", "  "); err == nil {
		_ = os.WriteFile(path, b, 0o644)
	}
}

func specKey(spec []string) string {
	b, _ := json.Marshal(spec)
	return string(b)
}

// recordHistory prepends an entry, de-duping any prior identical spec.
func recordHistory(path string, entry HistoryEntry) {
	entries := loadHistory(path)
	key := specKey(entry.Spec)
	filtered := make([]HistoryEntry, 0, len(entries)+1)
	filtered = append(filtered, entry)
	for _, e := range entries {
		if specKey(e.Spec) != key {
			filtered = append(filtered, e)
		}
	}
	saveHistory(path, filtered)
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}
