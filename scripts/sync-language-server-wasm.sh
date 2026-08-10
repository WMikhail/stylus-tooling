#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
GRAMMAR_DIR="$ROOT_DIR/vendor/tree-sitter-stylus"
TREE_SITTER="$GRAMMAR_DIR/node_modules/.bin/tree-sitter"
OUTPUT="$ROOT_DIR/packages/language-server/assets/tree-sitter-stylus.wasm"

if [[ ! -x "$TREE_SITTER" ]]; then
  echo "Missing Tree-sitter CLI. Run: npm ci --prefix vendor/tree-sitter-stylus" >&2
  exit 1
fi

"$TREE_SITTER" build --wasm --output "$OUTPUT" "$GRAMMAR_DIR"
echo "Updated packages/language-server/assets/tree-sitter-stylus.wasm"
