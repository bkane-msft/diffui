BINARY := git-diffui
PREFIX ?= $(HOME)/.local/bin

.PHONY: build test cover vet run install install-local clean vendor-monaco

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

clean:
	rm -f $(BINARY)

# Re-vendor the embedded Monaco editor (public/vs). Pass V=<version> to bump.
vendor-monaco:
	MONACO_VERSION=$(V) scripts/vendor-monaco.sh
