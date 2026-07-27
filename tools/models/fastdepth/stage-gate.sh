#!/usr/bin/env bash
# Rebuilds the untracked real-GPU gate payload under apps/docs/public/depth-gate/.
#
# The gate is a local dev aid: apps/docs/public/depth-gate/.gitignore contains
# "*", so index.html/browser.js and this payload are never committed (same
# convention as public/pose-gate/). This script regenerates everything the page
# needs, all under /depth-gate/ so the gate cannot accidentally validate the
# example's real /ort/ or /models/ staging:
#
#   model.onnx                 the audited candidate (via acquire.sh)
#   ort/                       the pinned onnxruntime-web 1.27.0 WebGPU runtime
#   images/room-{a,b}.jpg      the two licensed indoor fixtures
#
# Usage:
#   tools/models/fastdepth/stage-gate.sh [--cache DIR]
#
# Then serve the docs app and open:
#   http://localhost:3000/depth-gate/index.html
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
gate_dir="$repo_root/apps/docs/public/depth-gate"
ort_src="$repo_root/apps/docs/node_modules/onnxruntime-web/dist"
cache_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cache) cache_args=(--cache "$2"); shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$gate_dir/ort" "$gate_dir/images"
printf '*\n' > "$gate_dir/.gitignore"

# 1. Model: stage into the gate directory itself, hashes verified by acquire.sh.
"$here/acquire.sh" --out "$gate_dir/model-staging" "${cache_args[@]}"
mv "$gate_dir/model-staging/fastdepth-160x128.onnx" "$gate_dir/model.onnx"
rm -rf "$gate_dir/model-staging"

# 2. ORT runtime: the same three files the WebGPU entry point needs. Copied from
#    the pinned dependency, never a CDN.
if [[ ! -d "$ort_src" ]]; then
  echo "FAIL $ort_src is missing. Run pnpm install first." >&2
  exit 1
fi
for f in ort.webgpu.min.mjs ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
  install -m 0644 "$ort_src/$f" "$gate_dir/ort/$f"
done

# 3. Fixtures: pinned Wikimedia renditions, digests from image-credits.md.
fetch_image() {
  local name="$1" url="$2" want="$3" actual
  curl -fL --retry 3 -A 'vgpu-depth-gate/0.1' -o "$gate_dir/images/$name" "$url"
  actual="$(sha256sum "$gate_dir/images/$name" | cut -d' ' -f1)"
  if [[ "$actual" != "$want" ]]; then
    echo "FAIL images/$name sha256 $actual, expected $want" >&2
    exit 1
  fi
  echo "OK   images/$name ($actual)"
}

fetch_image room-a.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg/1280px-Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg' \
  '3d0ca0c9289afd6d1228481c57119c394603277946f22a70f90c6633f6f6cc80'

fetch_image room-b.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Larkspur_Bedroom_%26_Dressing_Room_%282%29_2024-10-08.jpg/1280px-Larkspur_Bedroom_%26_Dressing_Room_%282%29_2024-10-08.jpg' \
  '8f83f23be3759c7655590ebad24d572036d7f9767ad569bbc8b92cc55fc614d6'

echo
echo "gate payload staged in $gate_dir"
echo "index.html and browser.js are part of the same untracked payload; if they are"
echo "missing, restore them from the branch history or the author's working copy."
echo "Open: http://localhost:3000/depth-gate/index.html"
