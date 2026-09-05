#!/usr/bin/env bash
set -euo pipefail

ORACLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$ORACLE_DIR/../../../.." && pwd)
FIXTURE_PATH="$ORACLE_DIR/../fixtures/compute-draw.wgsl"
mkdir -p "$ROOT_DIR/.context"
SCRATCH_DIR=$(mktemp -d "$ROOT_DIR/.context/dc1-webgpu-oracle.XXXXXX")

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

run_oracle() {
  local output_path=$1
  local stderr_path=$2

  if ! node "$SCRATCH_DIR/oracle.mjs" "$FIXTURE_PATH" >"$output_path" 2>"$stderr_path"; then
    cat "$stderr_path" >&2
    return 1
  fi
  if [[ -s "$stderr_path" ]]; then
    cat "$stderr_path" >&2
    return 1
  fi
}

run_oracle "$SCRATCH_DIR/first.json" "$SCRATCH_DIR/first.stderr"
run_oracle "$SCRATCH_DIR/second.json" "$SCRATCH_DIR/second.stderr"

cmp "$SCRATCH_DIR/first.json" "$SCRATCH_DIR/second.json"
cmp "$ORACLE_DIR/expected.json" "$SCRATCH_DIR/first.json"
cat "$SCRATCH_DIR/first.json"
