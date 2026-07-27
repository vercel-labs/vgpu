#!/usr/bin/env bash
# Reproducible conversion of Google's official MediaPipe Hand Landmarker pair
# (palm detector + hand landmark) from the version-pinned `.task` bundle to ONNX.
#
# Tooling only: never invoked by the docs build, the example, or CI.
#
# It downloads the immutable float16 `hand_landmarker.task`, verifies its
# SHA-256, extracts the two TFLite graphs it contains, verifies *those* by
# SHA-256, converts each one separately with a pinned tf2onnx toolchain, and
# verifies the produced ONNX bytes against the digests recorded in
# PROVENANCE.md. Nothing downstream runs unless every hash matches.
#
# The `.task` bundle is a plain zip. Two graphs, two conversions, no fusion:
# the plan explicitly rejects a fused detector+crop ONNX.
#
# Usage:
#   tools/models/mediapipe-hands/convert.sh <workdir>
#   tools/models/mediapipe-hands/convert.sh <workdir> --venv /path/to/.venv
#
# See README.md for context and PROVENANCE.md for the full audit record.
set -euo pipefail

readonly TASK_URL='https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
readonly TASK_NAME='hand_landmarker.task'
readonly TASK_SHA='fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'
readonly TASK_BYTES=7819105

readonly DETECTOR_TFLITE='hand_detector.tflite'
readonly DETECTOR_TFLITE_SHA='945f713bc23570bd4ed60f848c401dc8eaf95713183d43ba14cf12e467d27a7d'
readonly DETECTOR_TFLITE_BYTES=2339878
readonly DETECTOR_ONNX='palm-detector.onnx'
readonly DETECTOR_ONNX_SHA='7830543b584df8b552d91ba51741678100039db8618df4de556434381ddabc9c'
readonly DETECTOR_ONNX_BYTES=4589374

readonly LANDMARK_TFLITE='hand_landmarks_detector.tflite'
readonly LANDMARK_TFLITE_SHA='6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9'
readonly LANDMARK_TFLITE_BYTES=5478949
readonly LANDMARK_ONNX='hand-landmark.onnx'
readonly LANDMARK_ONNX_SHA='b76d35dedf4c23210c8a927944000a6361fb145acdea2650d40e88d8914d89ce'
readonly LANDMARK_ONNX_BYTES=10903457

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workdir="${1:-}"
if [[ -z "$workdir" || "$workdir" == -* ]]; then
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
fi
shift
venv=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv) venv="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$workdir"
workdir="$(cd "$workdir" && pwd)"
cd "$workdir"

verify() {
  local path="$1" want_sha="$2" want_bytes="$3" bytes actual
  bytes=$(stat -c%s "$path")
  actual=$(sha256sum "$path" | cut -d' ' -f1)
  [[ "$bytes" == "$want_bytes" ]] || { echo "FAIL $path is $bytes bytes, expected $want_bytes" >&2; exit 1; }
  [[ "$actual" == "$want_sha" ]] || { echo "FAIL $path sha256 $actual, expected $want_sha" >&2; exit 1; }
  echo "OK   $path ($bytes bytes, sha256 $actual)"
}

# 1. Pinned toolchain. A container digest would be better; Docker was not
#    available where these files were produced, so versions are pinned exactly
#    and the outputs are pinned by hash, which is what protects the bytes.
if [[ -z "$venv" ]]; then
  venv="$workdir/.venv"
  if [[ ! -x "$venv/bin/python" ]]; then
    python3 -m venv "$venv"
    "$venv/bin/pip" install --no-input -r "$here/requirements.txt"
  fi
fi
[[ -x "$venv/bin/python" ]] || { echo "FAIL no python in $venv" >&2; exit 1; }
"$venv/bin/pip" freeze > pip-freeze.txt

# 2. Official upstream artifact, verified by hash before it is used at all.
if [[ ! -f "$TASK_NAME" ]]; then
  echo "..   downloading $TASK_BYTES bytes from $TASK_URL"
  curl -fL --retry 3 --max-time 300 -o "$TASK_NAME" "$TASK_URL"
fi
verify "$TASK_NAME" "$TASK_SHA" "$TASK_BYTES"

# 3. The .task bundle is a zip holding exactly the two graphs. Extract and pin
#    each one independently: the bundle hash alone would not survive a repack.
"$venv/bin/python" - "$TASK_NAME" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
    for wanted in ('hand_detector.tflite', 'hand_landmarks_detector.tflite'):
        if wanted not in names:
            raise SystemExit(f'FAIL {wanted} missing from the task bundle; found {names}')
        with open(wanted, 'wb') as fh:
            fh.write(z.read(wanted))
PY
verify "$DETECTOR_TFLITE" "$DETECTOR_TFLITE_SHA" "$DETECTOR_TFLITE_BYTES"
verify "$LANDMARK_TFLITE" "$LANDMARK_TFLITE_SHA" "$LANDMARK_TFLITE_BYTES"

# 4. Two mechanical format conversions. No simplifier, no constant folding, no
#    FP16 pass: whatever tf2onnx emits is what the gate loads.
"$venv/bin/python" -m tf2onnx.convert \
  --tflite "$DETECTOR_TFLITE" --output "$DETECTOR_ONNX" --opset 18 \
  2>&1 | tee conversion-detector.log
"$venv/bin/python" -m tf2onnx.convert \
  --tflite "$LANDMARK_TFLITE" --output "$LANDMARK_ONNX" --opset 18 \
  2>&1 | tee conversion-landmark.log

verify "$DETECTOR_ONNX" "$DETECTOR_ONNX_SHA" "$DETECTOR_ONNX_BYTES"
verify "$LANDMARK_ONNX" "$LANDMARK_ONNX_SHA" "$LANDMARK_ONNX_BYTES"

# 5. Contract inspection. PROVENANCE.md records both dumps; a custom-domain op
#    or a changed dtype/shape here is a hard stop, not a warning.
"$venv/bin/python" "$here/graph-dump.py" "$DETECTOR_ONNX" | tee graph-detector.json
"$venv/bin/python" "$here/graph-dump.py" "$LANDMARK_ONNX" | tee graph-landmark.json

for dump in graph-detector.json graph-landmark.json; do
  if grep -q '"com\.microsoft\|"ai\.onnx\.contrib\|"custom' "$dump"; then
    echo "FAIL $dump references a non-standard operator domain" >&2
    exit 1
  fi
done

printf '%s  %s\n' "$DETECTOR_ONNX_SHA" "$DETECTOR_ONNX" > SHA256SUMS
printf '%s  %s\n' "$LANDMARK_ONNX_SHA" "$LANDMARK_ONNX" >> SHA256SUMS
sha256sum -c SHA256SUMS

echo
echo "OK: $workdir/{$DETECTOR_ONNX,$LANDMARK_ONNX} match the recorded digests."
echo "Next: validate-cpu.py --models $workdir --images <hand photos>"
