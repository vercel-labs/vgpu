#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE_TAG=${IMAGE_TAG:-vgpu-test:s2}
CONTAINER_NAME=${CONTAINER_NAME:-vgpu-test-${$}}

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

cleanup

docker build --platform linux/arm64 -t "$IMAGE_TAG" -f "$ROOT_DIR/infra/test-docker/Dockerfile" "$ROOT_DIR"

docker run \
  --rm \
  --name "$CONTAINER_NAME" \
  --label vgpu-test=1 \
  -v "$ROOT_DIR/packages/render/tests/__snapshots__:/workspace/packages/render/tests/__snapshots__" \
  -v "$ROOT_DIR/packages/render/tests/inspect/__snapshots__:/workspace/packages/render/tests/inspect/__snapshots__" \
  -v "$ROOT_DIR/packages/render/tests/poc/__snapshots__:/workspace/packages/render/tests/poc/__snapshots__" \
  -v "$ROOT_DIR/packages/render/tests/primitives/__snapshots__:/workspace/packages/render/tests/primitives/__snapshots__" \
  -e VGPU_WRITE_SNAPSHOTS="${VGPU_WRITE_SNAPSHOTS:-}" \
  "$IMAGE_TAG" \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=$!; VGPU_DOCKER_TEST=1 pnpm test; status=$?; kill $xvfb_pid; exit $status'
