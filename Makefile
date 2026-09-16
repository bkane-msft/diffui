BINARY := git-diffui
PREFIX ?= $(HOME)/.local/bin
# Directory (on your zsh $fpath) to install the zsh completion into.
ZSH_COMPLETIONS_DIR ?= $(HOME)/.zsh/completions

.PHONY: build test cover vet run install install-local install-completions clean vendor-monaco test-e2e

build:
	go build -o $(BINARY) .

test:
	go test ./...

cover:
	go test -cover ./...

vet:
	go vet ./...

run: build
	./$(BINARY)

# Install to $GOBIN (usually ~/go/bin) so `git diffui` works if it's on PATH.
install:
	go install .

# Alternatively install a built binary into PREFIX (default ~/.local/bin).
install-local: build
	mkdir -p $(PREFIX)
	install -m 0755 $(BINARY) $(PREFIX)/$(BINARY)

# Install shell completion (branches/tags/ranges for `git diffui <TAB>`).
# Installs the zsh completion onto ZSH_COMPLETIONS_DIR and prints the one-line
# bash setup. Neither this nor any target edits your shell rc files.
install-completions:
	@install -d $(ZSH_COMPLETIONS_DIR)
	@install -m 0644 completions/git-diffui.zsh $(ZSH_COMPLETIONS_DIR)/_git-diffui
	@echo "zsh:  installed $(ZSH_COMPLETIONS_DIR)/_git-diffui"
	@echo "      if it's not already, add to ~/.zshrc BEFORE compinit:"
	@echo "          fpath=($(ZSH_COMPLETIONS_DIR) \$$fpath)"
	@echo "          autoload -Uz compinit && compinit"
	@echo "bash: add to ~/.bashrc (after git's completion is loaded):"
	@echo "          source $(CURDIR)/completions/git-diffui.bash"

clean:
	rm -f $(BINARY)

# Re-vendor the embedded Monaco editor (public/vs). Pass V=<version> to bump.
vendor-monaco:
	MONACO_VERSION=$(V) scripts/vendor-monaco.sh

# Frontend browser (E2E) tests: drive the inline-Monaco UI with Playwright.
# NOT part of `make test` / `go test` so contributors without the Playwright
# browser aren't broken. Requires a one-time `npx playwright install chromium`.
test-e2e: build
	@if [ ! -d node_modules ]; then npm install; fi
	npx playwright test
