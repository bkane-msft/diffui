#compdef git-diffui
#
# zsh completion for git-diffui and `git diffui`.
#
# Makes `git diffui <TAB>` (and the standalone `git-diffui <TAB>` binary)
# complete branches, tags, and commits — including `a..b` ranges — like
# `git diff <TAB>`, by reusing zsh's git completion helpers.
#
# Install: place this file, named `_git-diffui`, in a directory on your $fpath,
# then run compinit. For example:
#
#     mkdir -p ~/.zsh/completions
#     cp /path/to/diffui/completions/git-diffui.zsh ~/.zsh/completions/_git-diffui
#
# and in ~/.zshrc, BEFORE `compinit`:
#
#     fpath=(~/.zsh/completions $fpath)
#     autoload -Uz compinit && compinit
#
# The filename `_git-diffui` matters: zsh's git completion dispatches
# `git diffui` to a `_git-diffui` function, and the `#compdef git-diffui` line
# above registers the standalone `git-diffui` binary.

_git-diffui() {
  _arguments -s -S \
    '(-p --port)'{-p,--port}'[Port to listen on (default 4300)]:port' \
    '--host[Host to bind (default 127.0.0.1)]:host' \
    '--no-open[Do not auto-open the browser]' \
    '(--staged --cached)--staged[Diff the index against HEAD]' \
    '(--staged --cached)--cached[Diff the index against HEAD]' \
    '(-h --help)'{-h,--help}'[Show help]' \
    '*: :__git_revisions'
}

_git-diffui "$@"
