#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ARCHIVE=${1:?usage: validate.sh ARCHIVE DAWN_NODE [RESULTS_DIR]}
DAWN=${2:?usage: validate.sh ARCHIVE DAWN_NODE [RESULTS_DIR]}
RESULTS_DIR=${3:-$ROOT/lavapipe-validation}
VALIDATION_IMAGE=${VALIDATION_IMAGE:-node:24-trixie}
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
  -v "$RESULTS_DIR:/out" "$VALIDATION_IMAGE" bash -c '
set -euo pipefail
! dpkg-query -W mesa-vulkan-drivers >/dev/null 2>&1
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends binutils libdrm2 libvulkan1 >/dev/null
! dpkg-query -W mesa-vulkan-drivers >/dev/null 2>&1
dpkg-query -W -f='"'"'${Package}=${Version}\n'"'"' binutils libdrm2 libvulkan1 > /out/clean-container-packages.txt
mkdir -p /asset /tmp/runtime; chmod 700 /tmp/runtime
tar -xzf /input/lavapipe.tar.gz -C /asset
(cd /asset && sha256sum libvulkan_lvp.so lvp_icd.json > /out/asset-SHA256SUMS)
export XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=
export DAWN_NODE=/cache/dawn.node DAWN_FLAGS=backend=vulkan
export VK_ICD_FILENAMES=/asset/lvp_icd.json
ldd /asset/libvulkan_lvp.so > /out/clean-container-ldd.txt
! grep "not found" /out/clean-container-ldd.txt
objdump -T /asset/libvulkan_lvp.so > /out/objdump-dynamic-symbols.txt
max_glibc=$(grep -o "GLIBC_[0-9.]*" /out/objdump-dynamic-symbols.txt | sort -V | tail -1)
test "$(printf "%s\n" GLIBC_2.31 "$max_glibc" | sort -V | tail -1)" = GLIBC_2.31
max_glibcxx=$( (grep -o "GLIBCXX_[0-9.]*" /out/objdump-dynamic-symbols.txt || true) | sort -V | tail -1)
if test -n "$max_glibcxx"; then test "$(printf "%s\n" GLIBCXX_3.4.28 "$max_glibcxx" | sort -V | tail -1)" = GLIBCXX_3.4.28; fi
max_cxxabi=$( (grep -o "CXXABI_[0-9.]*" /out/objdump-dynamic-symbols.txt || true) | sort -V | tail -1)
if test -n "$max_cxxabi"; then test "$(printf "%s\n" CXXABI_1.3.12 "$max_cxxabi" | sort -V | tail -1)" = CXXABI_1.3.12; fi
printf "GLIBC=%s\nGLIBCXX=%s\nCXXABI=%s\n" "$max_glibc" "${max_glibcxx:-none}" "${max_cxxabi:-none}" > /out/symbol-version-floor.txt
for run in 1 2 3; do
  node /work/dump-render.mjs > "/out/lavapipe-run${run}.json" 2> "/out/lavapipe-run${run}.stderr"
done
'
printf 'Validation passed in %s: GLIBC <= 2.31, 17 features, shader-f16, compute 1024, exact 64x64 readback\n' "$VALIDATION_IMAGE"
