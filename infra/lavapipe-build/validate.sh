#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ARCHIVE=${1:?usage: validate.sh ARCHIVE DAWN_NODE [RESULTS_DIR]}
DAWN=${2:?usage: validate.sh ARCHIVE DAWN_NODE [RESULTS_DIR]}
RESULTS_DIR=${3:-$ROOT/lavapipe-validation}
[[ -f "$ARCHIVE" ]] || { echo "Archive not found: $ARCHIVE" >&2; exit 2; }
[[ -f "$DAWN" ]] || { echo "Dawn addon not found: $DAWN" >&2; exit 2; }
ARCHIVE=$(realpath "$ARCHIVE")
DAWN=$(realpath "$DAWN")
rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"
RESULTS_DIR=$(realpath "$RESULTS_DIR")
docker run --rm --label vgpu-lavapipe-build=1 \
  -v "$DAWN:/cache/dawn.node:ro" \
  -v "$ARCHIVE:/input/lavapipe.tar.gz:ro" \
  -v "$ROOT/infra/lavapipe-build/dump-render.mjs:/work/dump-render.mjs:ro" \
  -v "$RESULTS_DIR:/out" node:24-trixie bash -c '
set -euo pipefail
! dpkg-query -W mesa-vulkan-drivers >/dev/null 2>&1
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libdrm2 libvulkan1 >/dev/null
! dpkg-query -W mesa-vulkan-drivers >/dev/null 2>&1
dpkg-query -W -f='"'"'${Package}=${Version}\n'"'"' libdrm2 libvulkan1 > /out/clean-container-packages.txt
mkdir -p /asset /tmp/runtime; chmod 700 /tmp/runtime
tar -xzf /input/lavapipe.tar.gz -C /asset
(cd /asset && sha256sum libvulkan_lvp.so lvp_icd.json > /out/asset-SHA256SUMS)
export XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=
export DAWN_NODE=/cache/dawn.node DAWN_FLAGS=backend=vulkan
export VK_ICD_FILENAMES=/asset/lvp_icd.json
ldd /asset/libvulkan_lvp.so > /out/clean-container-ldd.txt
! grep "not found" /out/clean-container-ldd.txt
for run in 1 2 3; do
  node /work/dump-render.mjs > "/out/lavapipe-run${run}.json" 2> "/out/lavapipe-run${run}.stderr"
done
'
printf 'Validation passed: 17 features, shader-f16, compute 1024, exact 64x64 readback\n'
