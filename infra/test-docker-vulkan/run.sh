#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DAWN=${VGPU_DAWN_BINARY:-$HOME/.cache/vgpu/dawn/0.4.0-vgpu.1/linux-arm64-gnu/dawn-linux-arm64-gnu.node}
docker build --platform linux/arm64 -t vgpu-test-vulkan -f "$ROOT/infra/test-docker-vulkan/Dockerfile" "$ROOT"
docker run --rm --platform linux/arm64 --label vgpu-test=1 -e VGPU_DAWN_BINARY=/dawn.node -v "$DAWN:/dawn.node:ro" vgpu-test-vulkan
