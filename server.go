package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
)

// Label describes the two sides of a diff for the UI header.
type Label struct {
	Base   string `json:"base"`
	Target string `json:"target"`
	Text   string `json:"text"`
}

// Session is the payload returned by /api/session and /api/switch.
type Session struct {
	RepoRoot    string      `json:"repoRoot"`
	Spec        []string    `json:"spec"`
	Editable    bool        `json:"editable"`
	Label       Label       `json:"label"`
	Files       []FileEntry `json:"files"`
	Error       string      `json:"error,omitempty"`
	GeneratedAt string      `json:"generatedAt"`
}

// computeEditable reports whether the diff's target is the working tree (and
// thus editable). Staged, two-revision, and range diffs are read-only.
func computeEditable(spec []string) bool {
	revs := []string{}
	for _, a := range spec {
		if a == "--cached" || a == "--staged" {
			return false
		}
		if !strings.HasPrefix(a, "-") {
			revs = append(revs, a)
		}
	}
	if len(revs) >= 2 {
		return false
	}
	if len(revs) == 1 && strings.Contains(revs[0], "..") {
		return false
	}
	return true
}

func labelFor(spec []string) Label {
	revs := []string{}
	staged := false
	for _, a := range spec {
		if a == "--cached" || a == "--staged" {
			staged = true
		} else if !strings.HasPrefix(a, "-") {
			revs = append(revs, a)
		}
	}
	if staged {
		return Label{Base: "HEAD", Target: "Index (staged)", Text: "Staged changes (HEAD \u2192 index)"}
	}
	switch len(revs) {
	case 0:
		return Label{Base: "index", Target: "Working tree", Text: "Unstaged changes (index \u2192 working tree)"}
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
			return Label{Base: a, Target: b, Text: r}
		}
		return Label{Base: r, Target: "Working tree", Text: r + " \u2192 working tree"}
	default:
		return Label{Base: revs[0], Target: revs[1], Text: revs[0] + " \u2192 " + revs[1]}
	}
}

// DifuiServer holds mutable session state behind a mutex.
type DifuiServer struct {
	root        string
	historyPath string
	assets      fs.FS

	mu   sync.Mutex
	spec []string
}

func NewDifuiServer(root, historyPath string, spec []string, assets fs.FS) *DifuiServer {
	s := &DifuiServer{root: root, historyPath: historyPath, spec: spec, assets: assets}
	s.record()
	return s
}

func (s *DifuiServer) currentSpec() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.spec))
	copy(out, s.spec)
	return out
}

func (s *DifuiServer) record() {
	spec := s.currentSpec()
	recordHistory(s.historyPath, HistoryEntry{
		ID:       randID(),
		TS:       nowISO(),
		RepoRoot: s.root,
		Spec:     spec,
		Editable: computeEditable(spec),
		Label:    labelFor(spec).Text,
	})
}

func (s *DifuiServer) buildSession() Session {
	spec := s.currentSpec()
	sess := Session{
		RepoRoot:    s.root,
		Spec:        spec,
		Editable:    computeEditable(spec),
		Label:       labelFor(spec),
		GeneratedAt: nowISO(),
		Files:       []FileEntry{},
	}
	files, err := fileList(spec, s.root)
	if err != nil {
		sess.Error = err.Error()
	} else {
		sess.Files = files
	}
	return sess
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *DifuiServer) Handler() http.Handler {
	mux := http.NewServeMux()
	fileServer := http.FileServer(http.FS(s.assets))

	mux.HandleFunc("/api/session", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.buildSession())
	})

	mux.HandleFunc("/api/diff", func(w http.ResponseWriter, r *http.Request) {
		file := r.URL.Query().Get("path")
		if file == "" {
			writeJSON(w, 400, map[string]string{"error": "missing path"})
			return
		}
		spec := s.currentSpec()
		diff, err := fileDiff(spec, file, s.root)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"path": file, "diff": diff, "editable": computeEditable(spec)})
	})

	mux.HandleFunc("/api/file", func(w http.ResponseWriter, r *http.Request) {
		spec := s.currentSpec()
		if !computeEditable(spec) {
			writeJSON(w, 403, map[string]string{"error": "read-only diff"})
			return
		}
		switch r.Method {
		case http.MethodGet:
			file := r.URL.Query().Get("path")
			if file == "" {
				writeJSON(w, 400, map[string]string{"error": "missing path"})
				return
			}
			content, err := readWorkingFile(s.root, file)
			if err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			base, _ := readBaseFile(spec, file, s.root)
			writeJSON(w, 200, map[string]string{"path": file, "content": content, "base": base})
		case http.MethodPost:
			var body struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			data, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
			if err := json.Unmarshal(data, &body); err != nil || body.Path == "" {
				writeJSON(w, 400, map[string]string{"error": "path and content required"})
				return
			}
			if err := writeWorkingFile(s.root, body.Path, body.Content); err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			diff, err := fileDiff(spec, body.Path, s.root)
			if err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			add, del := countDiff(diff)
			writeJSON(w, 200, map[string]any{"ok": true, "path": body.Path, "diff": diff, "additions": add, "deletions": del})
		default:
			writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/history", func(w http.ResponseWriter, r *http.Request) {
		all := loadHistory(s.historyPath)
		entries := make([]HistoryEntry, 0, len(all))
		for _, e := range all {
			if e.RepoRoot == s.root {
				entries = append(entries, e)
			}
		}
		writeJSON(w, 200, map[string]any{"entries": entries, "current": s.currentSpec()})
	})

	mux.HandleFunc("/api/switch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "method not allowed"})
			return
		}
		var body struct {
			Spec []string `json:"spec"`
		}
		data, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err := json.Unmarshal(data, &body); err != nil {
			writeJSON(w, 400, map[string]string{"error": "spec must be an array of strings"})
			return
		}
		spec := []string{}
		for _, x := range body.Spec {
			if x != "" {
				spec = append(spec, x)
			}
		}
		// Validate the spec resolves before committing to it.
		if _, err := fileList(spec, s.root); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid diff spec: " + err.Error()})
			return
		}
		s.mu.Lock()
		s.spec = spec
		s.mu.Unlock()
		s.record()
		writeJSON(w, 200, s.buildSession())
	})

	// Static assets (index.html, app.js, style.css) from the embedded FS.
	mux.Handle("/", fileServer)

	return mux
}
