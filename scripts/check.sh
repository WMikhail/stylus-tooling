#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EXTENSION_DIR="$ROOT_DIR/editors/zed"
GRAMMAR_DIR="$ROOT_DIR/vendor/tree-sitter-stylus"
TREE_SITTER="$GRAMMAR_DIR/node_modules/.bin/tree-sitter"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tree-sitter-stylus.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

python3 "$ROOT_DIR/scripts/test-validate-extension.py"
python3 "$ROOT_DIR/scripts/validate-extension.py"
node "$ROOT_DIR/scripts/validate-language-server-package.mjs"
node "$ROOT_DIR/scripts/validate-versions.mjs"

(
  cd "$ROOT_DIR"
  npm run format:check
  npm run lint
)

(
  cd "$EXTENSION_DIR"
  cargo check
)

(
  cd "$ROOT_DIR"
  npm run build --workspace packages/language-server
  npm run check --workspace packages/language-server
  npm test --workspace packages/language-server
)

(
  cd "$ROOT_DIR"
  node scripts/test-language-server-package.mjs
)

if [[ ! -x "$TREE_SITTER" ]]; then
  echo "Missing Tree-sitter CLI. Run: cd vendor/tree-sitter-stylus && npm ci" >&2
  exit 1
fi

node --check "$GRAMMAR_DIR/grammar.js"

GENERATED_SNAPSHOT="$TEMP_DIR/generated"
mkdir -p "$GENERATED_SNAPSHOT"
GENERATED_ARTIFACTS=(src/grammar.json src/node-types.json src/parser.c)
for artifact in "${GENERATED_ARTIFACTS[@]}"; do
  cp "$GRAMMAR_DIR/$artifact" "$GENERATED_SNAPSHOT/$(basename "$artifact")"
done

(
  cd "$GRAMMAR_DIR"
  "$TREE_SITTER" generate
  "$TREE_SITTER" test
)

generated_stale=false
for artifact in "${GENERATED_ARTIFACTS[@]}"; do
  if ! cmp -s "$GENERATED_SNAPSHOT/$(basename "$artifact")" "$GRAMMAR_DIR/$artifact"; then
    generated_stale=true
  fi
done

if [[ "$generated_stale" == true ]]; then
  echo "Generated parser artifacts are stale. Regenerate and commit them." >&2
  git -C "$GRAMMAR_DIR" diff --stat -- src/grammar.json src/node-types.json src/parser.c
  exit 1
fi

FRESH_LANGUAGE_WASM="$TEMP_DIR/tree-sitter-stylus.wasm"
"$TREE_SITTER" build --wasm --output "$FRESH_LANGUAGE_WASM" "$GRAMMAR_DIR"
if ! cmp -s "$FRESH_LANGUAGE_WASM" "$ROOT_DIR/packages/language-server/assets/tree-sitter-stylus.wasm"; then
  echo "Language-server Tree-sitter WASM is stale. Run ./scripts/sync-language-server-wasm.sh and commit the result." >&2
  exit 1
fi

TREE_SITTER_CONFIG="$TEMP_DIR/config.json"
printf '{"parser-directories":["%s"]}\n' "$ROOT_DIR/vendor" > "$TREE_SITTER_CONFIG"

CRLF_FIXTURE="$TEMP_DIR/crlf.styl"
printf '.crlf\r\n  color red\r\n' > "$CRLF_FIXTURE"

DEEP_FIXTURE="$TEMP_DIR/deep-nesting.styl"
for ((depth = 0; depth < 255; depth++)); do
  printf '%*s.level-%d\n' "$((depth * 2))" '' "$depth" >> "$DEEP_FIXTURE"
done
printf '%*scolor red\n' 510 '' >> "$DEEP_FIXTURE"

FIXTURES=(
  "$ROOT_DIR/examples/smoke.styl"
  "$ROOT_DIR/examples/real_world/component_library.styl"
  "$ROOT_DIR/examples/real_world/partials/mixins.styl"
  "$ROOT_DIR/examples/real_world/partials/tokens.styl"
  "$ROOT_DIR/examples/real_world/stylus_docs_functions.styl"
  "$ROOT_DIR/examples/real_world/stylus_docs_media.styl"
  "$ROOT_DIR/tests/queries/brackets.styl"
  "$ROOT_DIR/tests/queries/highlights.styl"
  "$ROOT_DIR/tests/queries/indents.styl"
  "$ROOT_DIR/tests/queries/outline.styl"
  "$ROOT_DIR/tests/queries/overrides.styl"
  "$ROOT_DIR/tests/queries/tags.styl"
  "$ROOT_DIR/tests/queries/textobjects.styl"
  "$CRLF_FIXTURE"
  "$DEEP_FIXTURE"
)

(
  cd "$GRAMMAR_DIR"
  "$TREE_SITTER" parse --config-path "$TREE_SITTER_CONFIG" --quiet --stat "${FIXTURES[@]}"
  for fixture in "${FIXTURES[@]}"; do
    "$TREE_SITTER" query --config-path "$TREE_SITTER_CONFIG" --quiet queries/highlights.scm "$fixture"
    "$TREE_SITTER" query --config-path "$TREE_SITTER_CONFIG" --quiet queries/tags.scm "$fixture"
  done
)

python3 "$ROOT_DIR/scripts/test-queries.py"
node "$ROOT_DIR/scripts/test-stylus-compiler.mjs"
python3 "$ROOT_DIR/scripts/check-performance.py"

for query in highlights tags; do
  if ! cmp -s "$GRAMMAR_DIR/queries/$query.scm" "$EXTENSION_DIR/languages/stylus/$query.scm"; then
    echo "editors/zed/languages/stylus/$query.scm is out of sync; run ./scripts/sync-grammar-queries.sh" >&2
    exit 1
  fi
done

if [[ "${STYLUS_FUZZ_ITERATIONS:-0}" -gt 0 ]]; then
  (
    cd "$GRAMMAR_DIR"
    "$TREE_SITTER" fuzz --iterations "$STYLUS_FUZZ_ITERATIONS"
  )
fi

echo "All Stylus extension checks passed."
