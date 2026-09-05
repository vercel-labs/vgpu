#!/usr/bin/env bash
set -euo pipefail

ORACLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$ORACLE_DIR/../../../.." && pwd)
SCRATCH_DIR=$(mktemp -d "$ROOT_DIR/.context/c4-webgpu-oracle.XXXXXX")

cleanup() {
  rm -rf "$SCRATCH_DIR"
}
trap cleanup EXIT INT TERM

pnpm --dir "$ROOT_DIR/packages/vgpu-api" build >/dev/null
pnpm --dir "$ROOT_DIR" exec tsc --project "$ORACLE_DIR/tsconfig.json" --pretty false
pnpm --dir "$ROOT_DIR" exec esbuild "$ORACLE_DIR/oracle.ts" \
  --platform=node \
  --format=esm \
  --packages=external \
  --outfile="$SCRATCH_DIR/oracle.mjs" \
  --log-level=warning

node "$SCRATCH_DIR/oracle.mjs" >"$SCRATCH_DIR/first.json"
node "$SCRATCH_DIR/oracle.mjs" >"$SCRATCH_DIR/second.json"

cmp "$SCRATCH_DIR/first.json" "$SCRATCH_DIR/second.json"
cmp "$ORACLE_DIR/expected.json" "$SCRATCH_DIR/first.json"
cat "$SCRATCH_DIR/first.json"
