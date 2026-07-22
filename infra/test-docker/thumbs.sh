#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE_TAG=${IMAGE_TAG:-vgpu-test:s2}
CONTAINER_NAME=${CONTAINER_NAME:-vgpu-thumbs-${$}}
ARGS=("$@")
ARGS_QUOTED=""
if [ ${#ARGS[@]} -gt 0 ]; then
  printf -v ARGS_QUOTED ' %q' "${ARGS[@]}"
fi

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

cleanup

DOCKER_OUTPUT_ARGS=()
for output_var in VGPU_AA_MODE_OUTPUT_DIR VGPU_POST_PROCESSING_MODE_OUTPUT_DIR VGPU_BLACK_HOLE_VARIANT_OUTPUT_DIR VGPU_FFT_OCEAN_VARIANT_OUTPUT_DIR; do
  output_dir=${!output_var:-}
  if [ -n "$output_dir" ]; then
    mkdir -p "$output_dir"
    DOCKER_OUTPUT_ARGS+=(--env "$output_var=$output_dir" -v "$output_dir:$output_dir")
  fi
done

docker build --platform linux/arm64 -t "$IMAGE_TAG" -f "$ROOT_DIR/infra/test-docker/Dockerfile" "$ROOT_DIR"
docker image prune -f --filter "label=vgpu-test=1" >/dev/null

docker run \
  "${DOCKER_OUTPUT_ARGS[@]}" \
  --rm \
  --name "$CONTAINER_NAME" \
  --label vgpu-test=1 \
  -v "$ROOT_DIR/apps/docs/public/examples:/workspace/apps/docs/public/examples" \
  "$IMAGE_TAG" \
  sh -lc "Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=\$!; VGPU_DOCKER_TEST=1 pnpm --filter docs thumbs${ARGS_QUOTED}; status=\$?; kill \$xvfb_pid; exit \$status"
