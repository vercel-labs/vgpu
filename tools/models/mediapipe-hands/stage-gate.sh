#!/usr/bin/env bash
# Rebuilds the untracked real-GPU gate payload under apps/docs/public/hand-gate/.
#
# The gate is a local dev aid: apps/docs/public/hand-gate/.gitignore contains
# "*", so index.html/browser.js and this payload are never committed (same
# convention as public/pose-gate/ and public/depth-gate/). Everything the page
# needs lives under /hand-gate/ so the gate cannot accidentally validate the
# example's real /ort/ or /models/ staging:
#
#   models/palm-detector.onnx      the converted 192x192 palm detector
#   models/hand-landmark.onnx      the converted 224x224 hand landmark model
#   ort/                           the pinned onnxruntime-web 1.27.0 WebGPU runtime
#   images/one-hand-rotated.jpg    licensed single-hand fixture (ROI rotation ~88 deg)
#   images/two-hands-sky.jpg       licensed two-hand fixture
#   golden.json                    the CPU-EP reference the browser is checked against
#   SHA256SUMS.models              digests of the two models
#   SHA256SUMS.local               digests of everything staged
#
# Usage:
#   tools/models/mediapipe-hands/stage-gate.sh [--work DIR] [--venv DIR] [--skip-golden]
#
# Then serve the docs app and open:
#   http://localhost:3006/hand-gate/index.html
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
gate_dir="$repo_root/apps/docs/public/hand-gate"
ort_src="$repo_root/apps/docs/node_modules/onnxruntime-web/dist"
work_dir=''
venv=''
skip_golden=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --work) work_dir="$2"; shift 2 ;;
    --venv) venv="$2"; shift 2 ;;
    --skip-golden) skip_golden=1; shift ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$work_dir" ]]; then
  work_dir="$(mktemp -d -t mediapipe-hands-XXXXXX)"
fi
mkdir -p "$work_dir" "$gate_dir/ort" "$gate_dir/images" "$gate_dir/models"
printf '*\n' > "$gate_dir/.gitignore"

# 1. Models: convert (or re-verify) into the work directory, then copy in. Every
#    digest is checked by convert.sh before anything is staged.
convert_args=("$work_dir")
[[ -n "$venv" ]] && convert_args+=(--venv "$venv")
"$here/convert.sh" "${convert_args[@]}"
install -m 0644 "$work_dir/palm-detector.onnx" "$gate_dir/models/palm-detector.onnx"
install -m 0644 "$work_dir/hand-landmark.onnx" "$gate_dir/models/hand-landmark.onnx"
install -m 0644 "$here/LICENSE" "$gate_dir/models/LICENSE"
install -m 0644 "$here/PROVENANCE.md" "$gate_dir/models/PROVENANCE.md"
install -m 0644 "$work_dir/SHA256SUMS" "$gate_dir/SHA256SUMS.models"

# 2. ORT runtime: the three files the WebGPU entry point needs, copied from the
#    pinned dependency, never a CDN.
if [[ ! -d "$ort_src" ]]; then
  echo "FAIL $ort_src is missing. Run pnpm install first." >&2
  exit 1
fi
for f in ort.webgpu.min.mjs ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
  install -m 0644 "$ort_src/$f" "$gate_dir/ort/$f"
done

# 3. Fixtures: pinned Wikimedia renditions, digests and attribution from
#    image-credits.md. Both were chosen by running the converted models over a
#    wider candidate set; the COCO pose fixtures do not show hands well enough.
fetch_image() {
  local name="$1" url="$2" want="$3" actual
  if [[ -f "$gate_dir/images/$name" ]] &&
     [[ "$(sha256sum "$gate_dir/images/$name" | cut -d' ' -f1)" == "$want" ]]; then
    echo "OK   images/$name (cached)"
    return
  fi
  curl -fL --retry 3 -A 'vgpu-hand-gate/0.1' -o "$gate_dir/images/$name" "$url"
  actual="$(sha256sum "$gate_dir/images/$name" | cut -d' ' -f1)"
  if [[ "$actual" != "$want" ]]; then
    echo "FAIL images/$name sha256 $actual, expected $want" >&2
    exit 1
  fi
  echo "OK   images/$name ($actual)"
}

fetch_image two-hands-sky.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Open_Hands_Facing_The_Heavens.jpg/960px-Open_Hands_Facing_The_Heavens.jpg' \
  '68cdcb3a2bc40b3e2dc6f0ae8cf1551ecd4abac661515a5ef0e75db39030b872'

fetch_image one-hand-rotated.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/Pride.be_2018-05-19_14-56-07_ILCE-6500_DSC08078_DxO_%2828675186077%29.jpg/960px-Pride.be_2018-05-19_14-56-07_ILCE-6500_DSC08078_DxO_%2828675186077%29.jpg' \
  '340356d94b2cffc6581732c028677d24f6965939fe158a7cee09185a131b90c8'

install -m 0644 "$here/image-credits.md" "$gate_dir/images/CREDITS.md"

# 4. Golden: the CPU-EP reference the browser compares itself against. Produced
#    by the same validator that proved the graphs offline, so the gate's
#    "matches CPU reference" check is not comparing the browser to itself.
if [[ "$skip_golden" == 0 ]]; then
  golden_python="${venv:-$work_dir/.venv}/bin/python"
  if [[ ! -x "$golden_python" ]]; then
    echo "FAIL no python at $golden_python for the golden dump" >&2
    exit 1
  fi
  "$golden_python" "$here/validate-cpu.py" \
    --models "$work_dir" \
    --images "$gate_dir/images/one-hand-rotated.jpg" "$gate_dir/images/two-hands-sky.jpg" \
    --expect-two-hands two-hands-sky.jpg \
    --json "$gate_dir/golden.json"
fi

(cd "$gate_dir" && find . -type f ! -name 'SHA256SUMS.local' ! -name '.gitignore' \
  -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.local)

echo
echo "gate payload staged in $gate_dir"
echo "index.html and browser.js are part of the same untracked payload; if they"
echo "are missing, restore them from the author's working copy."
echo "Open: http://localhost:3006/hand-gate/index.html"
