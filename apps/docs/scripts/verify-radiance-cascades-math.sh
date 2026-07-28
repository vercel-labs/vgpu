#!/usr/bin/env bash
# Runs the radiance-cascades debug-extraction harness inside the deterministic container.
#
# This host has no GPU adapter (`vgpu doctor` fails its render probe), so the fallback from
# docs/topics/shader-debugging.docs.md applies: the repository's own CI image plus Xvfb.
# Results are identical to CI, and the evidence lands in $OUT.
set -euo pipefail

ROOT=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
OUT=${OUT:-/home/user/vgpu-webgpu-shots/radiance-cascades-debug}
IMAGE_TAG=${IMAGE_TAG:-vgpu-test-dev:ci}

mkdir -p "$OUT"
docker run --rm \
  -v "$ROOT:/workspace" \
  -v "$OUT:/out" \
  -w /workspace \
  -e OUT=/out \
  -e VGPU_DOCKER_TEST=1 \
  "$IMAGE_TAG" \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=$!; DISPLAY=:99 node apps/docs/scripts/radiance-cascades-math-harness.mjs; status=$?; kill $xvfb_pid; exit $status'
