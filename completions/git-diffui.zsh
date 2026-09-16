#compdef git-diffui
#
# zsh completion for `git diffui` and the standalone `git-diffui` binary.
#
# Makes `git diffui <TAB>` (and `git-diffui <TAB>`) complete branches, tags,
# and commits — including `a..b` ranges — like `git diff <TAB>`.
#
# HOW IT WORKS (important for the filename):
#   git ships its own zsh completion wrapper (git-completion.zsh, installed as
#   `_git`). For a subcommand `foo`, that wrapper looks up and runs the function
#   named `_git_foo` (subcommand dashes become underscores). So for `git diffui`
#   it wants a function called `_git_diffui` — with UNDERSCORES. This file is
#   therefore named `_git_diffui` and defines that exact function, which also
#   lets it serve the standalone `git-diffui` binary via the `#compdef` line
#   above. A file named `_git-diffui` (with a dash) is NOT found by git's
#   wrapper and `git diffui` silently falls back to filename completion.
#
# Install: place this file, named `_git_diffui`, in a directory on your $fpath,
# then run compinit. The binary embeds this script, so the easiest way is:
#
#     mkdir -p ~/.zsh/completions
#     git diffui completion zsh > ~/.zsh/completions/_git_diffui
#
# (Or copy this file directly:
#     cp /path/to/diffui/completions/git-diffui.zsh ~/.zsh/completions/_git_diffui )
#
# and in ~/.zshrc, BEFORE `compinit`, make sure that dir is on $fpath:
#
#     fpath=(~/.zsh/completions $fpath)
#     autoload -Uz compinit && compinit

# Prefer git's own diff completion for perfect fidelity (refs, ranges, paths,
# and diff flags). git's completion defines `_git_diff` (bash-bridge wrapper,
# the common macOS/Homebrew case) or `_git-diff` (zsh-native git completion);
# whichever is loaded, reuse it and we're done.
if (( $+functions[_git_diff] )); then
  _git_diff
  return
fi
if (( $+functions[_git-diff] )); then
  _git-diff
  return
fi

# Fallback: self-contained completion for the standalone `git-diffui` binary,
# when git's own completion helpers are not loaded. Must NOT reference git's
# internal helpers (e.g. __git_revisions), which are undefined in this context.
local state
_arguments -s -S \
  '(-p --port)'{-p,--port}'[Port to listen on (default 4300)]:port:' \
  '--host[Host to bind (default 127.0.0.1)]:host:' \
  '--no-open[Do not auto-open the browser]' \
  '(--staged --cached)--staged[Diff the index against HEAD]' \
  '(--staged --cached)--cached[Diff the index against HEAD]' \
  '(-h --help)'{-h,--help}'[Show help]' \
  '*: :->refs'

if [[ $state == refs ]]; then
  local -a refs
  refs=(
    ${(f)"$(command git for-each-ref --format='%(refname:short)' \
              refs/heads refs/tags refs/remotes 2>/dev/null)"}
    HEAD
  )
  _describe -t refs 'ref' refs
fi
