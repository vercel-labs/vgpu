#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node22/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
ART="$ROOT/artifacts"
CACHE="$(mktemp -d)"
RUNTIME="$(mktemp -d)"
cleanup(){ rm -rf "$CACHE" "$RUNTIME" >/dev/null 2>&1 & }
trap cleanup EXIT
chmod 700 "$RUNTIME"
export VGPU_CACHE_DIR="$CACHE" XDG_RUNTIME_DIR="$RUNTIME"
LOG="$ART/node-fallback.log"
: >"$LOG"
echo "HOST_FALLBACK: public webgpu@0.4.0 recipe requires glibc>=2.38 on ARM64; using supported adapter-node portable Dawn/software-renderer 0.1.6" >>"$LOG"
pnpm --dir "$REPO" exec vgpu install-dawn >>"$LOG" 2>&1
pnpm --dir "$REPO" exec vgpu install-software-renderer >>"$LOG" 2>&1
node --experimental-strip-types "$ROOT/node/fallback-adapter-node.ts" >>"$LOG" 2>&1
grep -E '^(HOST_FALLBACK|Downloaded)|"status": "PASS"' "$LOG"
grep -F '"status": "PASS"' "$ART/node-fallback.json"
echo 0 >"$ART/node-fallback.rc"
