#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node22/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
CACHE="$(mktemp -d -t vgpu-ort-cache.XXXXXX)"
RUNTIME="$(mktemp -d -t vgpu-ort-runtime.XXXXXX)"
ARTIFACTS="${ORT_EVIDENCE_DIR:-$ROOT/artifacts}"
trap 'rm -rf -- "$CACHE" "$RUNTIME"' EXIT
[[ "$(node --version)" == v22.* ]] || { echo "Node 22 required" >&2; exit 2; }
mkdir -p "$ARTIFACTS"
chmod 700 "$RUNTIME"
export VGPU_CACHE_DIR="$CACHE" XDG_RUNTIME_DIR="$RUNTIME" ORT_EVIDENCE_DIR="$ARTIFACTS"
renderer_install="$(pnpm --dir "$REPO" exec vgpu install-software-renderer)"
echo "$renderer_install"
export VK_ICD_FILENAMES="${renderer_install##*: }"
[[ -f "$VK_ICD_FILENAMES" ]] || { echo "Portable Vulkan ICD was not installed: $VK_ICD_FILENAMES" >&2; exit 2; }
node --experimental-strip-types "$ROOT/node/negative-generic-wasm.ts" 2>&1 | tee "$ARTIFACTS/node-negative.log"
grep -F "NEGATIVE_PASS generic WASM failed with webgpuInit is not a function" "$ARTIFACTS/node-negative.log"
node --experimental-strip-types "$ROOT/node/run.ts" 2>&1 | tee "$ARTIFACTS/node.log"
grep -F '"status": "PASS"' "$ARTIFACTS/node.json"
