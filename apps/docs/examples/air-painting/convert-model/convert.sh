#!/usr/bin/env bash
# Reproduces apps/docs/public/models/movenet/movenet-lightning.onnx.
#
# Tooling only: never invoked by the docs build, the example, or CI.
# See README.md for context and the recorded hashes.
set -euo pipefail

WORKDIR="${1:-}"
if [[ -z "$WORKDIR" ]]; then
  echo "usage: $0 <workdir>" >&2
  exit 2
fi

TFLITE_NAME='movenet-singlepose-lightning-float16-v4.tflite'
TFLITE_URL='https://tfhub.dev/google/lite-model/movenet/singlepose/lightning/tflite/float16/4?lite-format=tflite'
TFLITE_SHA='0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab'
ONNX_NAME='movenet-lightning.onnx'
ONNX_SHA='0f4ca5f5049e8b43ee976f25f05f3455aa0cc66cafb50bc5f378b68a558a684b'

mkdir -p "$WORKDIR"
cd "$WORKDIR"

# 1. Pinned toolchain. A container digest would be better; Docker was not
#    available where the checked-in file was produced, so versions are pinned
#    exactly and the outputs are pinned by hash.
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/pip install --no-input \
    pip==24.3.1 tf2onnx==1.16.1 onnx==1.17.0 onnxruntime==1.20.1 \
    pillow==11.1.0 tensorflow==2.15.1
fi
.venv/bin/pip freeze > pip-freeze.txt

# 2. Official upstream artifact, verified by hash before it is used.
if [[ ! -f "$TFLITE_NAME" ]]; then
  curl -L --fail --max-time 300 "$TFLITE_URL" -o "$TFLITE_NAME"
fi
echo "${TFLITE_SHA}  ${TFLITE_NAME}" | sha256sum -c -

# 3. Mechanical format conversion. No simplifier, no folding, no FP16 pass:
#    whatever tf2onnx emits is what ships.
.venv/bin/python -m tf2onnx.convert \
  --tflite "$TFLITE_NAME" \
  --output "$ONNX_NAME" \
  --opset 18 2>&1 | tee conversion.log

# 4. The redistributed bytes must match what PROVENANCE.md records.
echo "${ONNX_SHA}  ${ONNX_NAME}" | sha256sum -c -

# 5. Contract inspection: uint8 [1,192,192,3] in, float32 [1,1,17,3] out.
.venv/bin/python "$(dirname "$(readlink -f "$0")")/graph-dump.py" "$ONNX_NAME" \
  | tee graph-inspection.json

echo
echo "OK: ${WORKDIR}/${ONNX_NAME} matches the checked-in model."
