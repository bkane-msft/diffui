#!/usr/bin/env bash
#
# Vendor the Monaco editor into public/vs so it can be //go:embed-ed into the
# single static diffui binary (no CDN, works offline).
#
# It downloads the pinned monaco-editor release from the npm registry via
# `npm pack` (no install, no node_modules), copies the parts we actually use,
# and trims the heavy language-service workers we don't (TypeScript/JSON/CSS/
# HTML IntelliSense). Syntax highlighting for all "basic" languages and the
# diff engine are preserved.
#
# Usage:
#   scripts/vendor-monaco.sh              # vendor the pinned MONACO_VERSION
#   scripts/vendor-monaco.sh 0.53.0       # vendor a specific version
#   MONACO_VERSION=0.53.0 scripts/vendor-monaco.sh
#
# To bump the version permanently, edit MONACO_VERSION below (and commit the
# refreshed public/vs).

set -euo pipefail

# Pinned Monaco version. Override via arg 1 or the MONACO_VERSION env var.
MONACO_VERSION="${1:-${MONACO_VERSION:-0.52.2}}"

# Resolve repo root from this script's location so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/public/vs"

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required to fetch monaco-editor" >&2
  exit 1
fi

echo "Vendoring monaco-editor@$MONACO_VERSION -> $DEST"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Download the tarball (no install) and unpack it.
(
  cd "$TMP"
  npm pack "monaco-editor@$MONACO_VERSION" >/dev/null
  tar -xzf "monaco-editor-$MONACO_VERSION.tgz"
)

SRC="$TMP/package/min/vs"
if [ ! -d "$SRC" ]; then
  echo "error: expected $SRC in the downloaded package" >&2
  exit 1
fi

# Rebuild public/vs from scratch.
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy only what we need. We intentionally skip:
#   - min/vs/language/**  (TS/JSON/CSS/HTML language services; ~7MB of workers)
#   - min/vs/nls.messages.*.js (non-English localization bundles)
cp -R "$SRC/base" "$DEST/base"
cp -R "$SRC/basic-languages" "$DEST/basic-languages"
cp -R "$SRC/editor" "$DEST/editor"
cp "$SRC/loader.js" "$DEST/loader.js"

# License / attribution (Monaco is MIT).
cp "$TMP/package/LICENSE" "$DEST/LICENSE" 2>/dev/null || true
cp "$TMP/package/ThirdPartyNotices.txt" "$DEST/ThirdPartyNotices.txt" 2>/dev/null || true

# Record the vendored version for provenance.
printf '%s\n' "$MONACO_VERSION" > "$DEST/VERSION"

# Sanity check: //go:embed silently skips files/dirs starting with "." or "_".
if find "$DEST" \( -name '.*' -o -name '_*' \) -print -quit | grep -q .; then
  echo "warning: vendored tree contains dot/underscore-prefixed entries that go:embed will skip:" >&2
  find "$DEST" \( -name '.*' -o -name '_*' \) >&2
fi

echo "Done. Vendored $(du -sh "$DEST" | cut -f1) into public/vs (monaco $MONACO_VERSION)."
echo "Rebuild the binary to embed it: make build"
