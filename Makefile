BINARY := git-diffui
PREFIX ?= $(HOME)/.local/bin

.PHONY: build test cover vet run install install-local clean

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
