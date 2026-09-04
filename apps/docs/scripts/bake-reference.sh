#!/usr/bin/env bash
# Renders the bake-plan reference set into $1 (see docs/plans/atmosphere-bakes.md).
set -euo pipefail
out=$1
cd "$(dirname "$0")/.."
for p in golden-hour noon twilight high-altitude stratosphere; do
  node scripts/render-atmosphere.mjs --out "$out" --preset "$p" | grep '^- '
done
node scripts/render-atmosphere.mjs --out "$out/up" --preset noon --pitch 35 --coverage 0.5 | grep '^- '
mv "$out/up/noon.png" "$out/noon-up.png" && rmdir "$out/up"
