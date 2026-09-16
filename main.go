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

//go:embed completions/git-diffui.bash completions/git-diffui.zsh
var completionScripts embed.FS

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

SHELL COMPLETION
  git diffui completion bash    Print the bash completion script to stdout
  git diffui completion zsh     Print the zsh completion script to stdout

  bash:  add to ~/.bashrc (after git's completion is loaded):
             source <(git diffui completion bash)
  zsh:   save onto a directory in your $fpath, then run compinit:
             git diffui completion zsh > ~/.zsh/completions/_git-diffui
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

const completionHelpText = `git diffui completion — print a shell completion script.

USAGE
  git diffui completion bash    Print the bash completion script to stdout
  git diffui completion zsh     Print the zsh completion script to stdout

  bash:  source <(git diffui completion bash)          # e.g. in ~/.bashrc
  zsh:   git diffui completion zsh > ~/.zsh/completions/_git-diffui

Both reuse git's own ref-completion helpers, so git's completion must be
loaded first (it usually is). See the scripts' header comments for details.
`

// runCompletion implements the `git diffui completion <shell>` subcommand. It
// writes the embedded completion script for the requested shell to stdout so it
// can be sourced (bash) or saved onto $fpath (zsh). A leading path is tolerated
// so `git diffui completion "$SHELL"` (e.g. /bin/zsh) works.
func runCompletion(args []string) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Print(completionHelpText)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	name := strings.ToLower(filepath.Base(strings.TrimSpace(args[0])))
	var file string
	switch {
	case strings.Contains(name, "bash"):
		file = "completions/git-diffui.bash"
	case strings.Contains(name, "zsh"):
		file = "completions/git-diffui.zsh"
	default:
		fmt.Fprintf(os.Stderr, "git diffui completion: unsupported shell %q (supported: bash, zsh)\n", args[0])
		return 2
	}
	data, err := completionScripts.ReadFile(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	os.Stdout.Write(data)
	return 0
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
	if len(argv) > 0 && argv[0] == "completion" {
		return runCompletion(argv[1:])
	}
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
