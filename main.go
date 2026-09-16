package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

//go:embed public
var embedded embed.FS

const helpText = `git diffui — GitHub-style web UI for git diffs, with editable working-tree files.

USAGE
  git diffui [options] [<revisions>]

WHAT IT SHOWS
  git diffui                 Uncommitted changes (HEAD -> working tree)   [editable]
  git diffui --staged        Staged changes (HEAD -> index)              [read-only]
  git diffui <commit>        <commit> -> working tree                     [editable]
  git diffui <a> <b>         <a> -> <b> (historical)                     [read-only]
  git diffui <a>..<b>        Range between two commits                   [read-only]

  In editable views the working-tree side can be edited in the browser and saved
  straight back to disk; the diff re-computes live.

OPTIONS
  -p, --port <n>     Port to listen on (default: 4300, auto-increments if busy)
      --host <h>     Host to bind (default: 127.0.0.1)
      --no-open      Do not auto-open the browser
      --staged       Diff the index against HEAD (alias: --cached)
  -h, --help         Show this help

HISTORY
  Every launch is recorded per-repo (in <git-dir>/diffui/history.json). Open the
  History panel in the UI to revisit past diffs.
`

type options struct {
	port int
	host string
	open bool
	spec []string
	help bool
}

// parseArgs turns CLI arguments into options. It is pure and testable.
func parseArgs(argv []string) (options, error) {
	opts := options{port: 4300, host: "127.0.0.1", open: true}
	revs := []string{}
	staged := false
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch {
		case a == "-h" || a == "--help":
			opts.help = true
		case a == "--no-open":
			opts.open = false
		case a == "--staged" || a == "--cached":
			staged = true
		case a == "-p" || a == "--port":
			if i+1 >= len(argv) {
				return opts, fmt.Errorf("missing value for %s", a)
			}
			i++
			n, err := strconv.Atoi(argv[i])
			if err != nil {
				return opts, fmt.Errorf("invalid port: %s", argv[i])
			}
			opts.port = n
		case a == "--host":
			if i+1 >= len(argv) {
				return opts, fmt.Errorf("missing value for --host")
			}
			i++
			opts.host = argv[i]
		case strings.HasPrefix(a, "--port="):
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--port="))
			if err != nil {
				return opts, fmt.Errorf("invalid port")
			}
			opts.port = n
		case strings.HasPrefix(a, "--host="):
			opts.host = strings.TrimPrefix(a, "--host=")
		default:
			revs = append(revs, a)
		}
	}
	switch {
	case staged:
		opts.spec = []string{"--cached"}
	case len(revs) > 0:
		opts.spec = revs
	default:
		opts.spec = []string{"HEAD"} // all uncommitted changes vs last commit
	}
	return opts, nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// listenAuto binds host:port, incrementing the port up to attempts times when
// the address is already in use.
func listenAuto(host string, port, attempts int) (net.Listener, int, error) {
	for i := 0; i <= attempts; i++ {
		addr := net.JoinHostPort(host, strconv.Itoa(port+i))
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, port + i, nil
		}
		if !strings.Contains(err.Error(), "in use") && !strings.Contains(err.Error(), "EADDRINUSE") {
			return nil, 0, err
		}
	}
	return nil, 0, fmt.Errorf("no free port in range %d-%d", port, port+attempts)
}

func run(argv []string) int {
	opts, err := parseArgs(argv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if opts.help {
		fmt.Print(helpText)
		return 0
	}

	cwd, _ := os.Getwd()
	root, err := repoRoot(cwd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Not a git repository (run git diffui inside a repo).")
		return 1
	}
	gd, err := gitDir(cwd)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	historyPath := filepath.Join(gd, "diffui", "history.json")

	assets, err := fs.Sub(embedded, "public")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	srv := NewDifuiServer(root, historyPath, opts.spec, assets)

	ln, port, err := listenAuto(opts.host, opts.port, 20)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to start server:", err)
		return 1
	}
	url := fmt.Sprintf("http://%s:%d/", opts.host, port)
	fmt.Printf("git diffui -> %s\n", url)
	fmt.Printf("  repo:  %s\n", root)
	fmt.Printf("  diff:  %s\n", strings.Join(opts.spec, " "))
	fmt.Println("  Ctrl+C to stop.")
	if opts.open {
		openBrowser(url)
	}

	if err := http.Serve(ln, srv.Handler()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:]))
}
