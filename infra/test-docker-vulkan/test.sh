#!/usr/bin/env bash
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY VGPU_DAWN_FLAGS
export VK_ICD_FILENAMES=${VK_ICD_FILENAMES:-$(find /usr/share/vulkan/icd.d -name 'lvp_icd*.json' | head -1)}
echo "Node: $(node --version)"
vulkaninfo --summary
VGPU_DOCKER_TEST=1 pnpm exec vitest run packages/adapter-node/tests/buffer-readback.test.ts
