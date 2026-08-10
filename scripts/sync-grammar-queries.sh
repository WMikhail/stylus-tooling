#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/vendor/tree-sitter-stylus/queries"
TARGET_DIR="$ROOT_DIR/editors/zed/languages/stylus"

cp "$SOURCE_DIR/highlights.scm" "$TARGET_DIR/highlights.scm"
cp "$SOURCE_DIR/tags.scm" "$TARGET_DIR/tags.scm"
