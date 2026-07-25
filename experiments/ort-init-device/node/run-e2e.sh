#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node22/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$(mktemp -d -t vgpu-ort-cache.XXXXXX)"
ARTIFACTS="${ORT_EVIDENCE_DIR:-$ROOT/artifacts}"
trap 'rm -rf -- "$CACHE"' EXIT
[[ "$(node --version)" == v22.* ]] || { echo "Node 22 required" >&2; exit 2; }
mkdir -p "$ARTIFACTS"
export VGPU_CACHE_DIR="$CACHE" ORT_EVIDENCE_DIR="$ARTIFACTS"
node --experimental-strip-types "$ROOT/node/negative-generic-wasm.ts" 2>&1 | tee "$ARTIFACTS/node-negative.log"
grep -F "NEGATIVE_PASS generic WASM failed with webgpuInit is not a function" "$ARTIFACTS/node-negative.log"
node --experimental-strip-types "$ROOT/node/run.ts" 2>&1 | tee "$ARTIFACTS/node.log"
grep -F '"status": "PASS"' "$ARTIFACTS/node.json"
