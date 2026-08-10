#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

status=0

python3 "$ROOT_DIR/scripts/validate-extension.py" --release || status=$?
node "$ROOT_DIR/scripts/validate-language-server-package.mjs" --release || status=$?
node "$ROOT_DIR/scripts/validate-versions.mjs" || status=$?

if [[ $status -ne 0 ]]; then
  exit "$status"
fi

echo "Public release metadata is valid."
