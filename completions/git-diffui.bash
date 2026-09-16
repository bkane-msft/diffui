# bash completion for git-diffui
#
# Makes `git diffui <TAB>` (and the standalone `git-diffui <TAB>` binary)
# complete branches, tags, and commits — including `a..b` / `a...b` ranges —
# exactly like `git diff <TAB>`.
#
# It reuses git's own ref-completion helpers, so git's bash completion
# (git-completion.bash) must be loaded first. Most git installs load it
# automatically; on macOS with Homebrew it's typically
# `/opt/homebrew/etc/bash_completion.d/git-completion.bash`. Then add to your
# ~/.bashrc, AFTER git's completion is sourced:
#
#     source /path/to/diffui/completions/git-diffui.bash
#
# git's completion auto-dispatches `git diffui` to the function named
# `_git_diffui` (subcommand dashes become underscores), so defining it is all
# that's needed for the `git diffui` form.

_git_diffui ()
{
	case "${cur-}" in
	--port=*|--host=*)
		# Freeform values; nothing to complete.
		return
		;;
	--*)
		__gitcomp "--port= --host= --no-open --staged --cached --help"
		return
		;;
	esac
	# Complete refs and ranges (branches, tags, commits, a..b), like git diff.
	__git_complete_revlist
}

# Enable completion for the binary invoked directly as `git-diffui`.
# __git_complete sets up git's completion context (cur/prev/words/cword) and
# then calls our function, so ref completion works the same either way.
if declare -f __git_complete >/dev/null 2>&1; then
	__git_complete git-diffui _git_diffui
fi
