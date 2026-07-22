#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MESA_VERSION=${MESA_VERSION:-${1:-25.0.7}}
ARCH=${ARCH:-${2:-$(uname -m)}}
MESA_SHA256=${MESA_SHA256:-592272df3cf01e85e7db300c449df5061092574d099da275d19e97ef0510f8a6}
OUTPUT_DIR=${OUTPUT_DIR:-$ROOT/lavapipe-out}
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x64|x86_64|amd64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 2 ;;
esac
IMAGE="vgpu-lavapipe-build:${MESA_VERSION}-${ARCH}"
container=
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/asset" "$OUTPUT_DIR/evidence"
docker build --pull \
  --label vgpu-lavapipe-build=1 \
  --build-arg "MESA_VERSION=$MESA_VERSION" \
  --build-arg "MESA_SHA256=$MESA_SHA256" \
  --tag "$IMAGE" --file "$ROOT/infra/lavapipe-build/Dockerfile" "$ROOT"
container=$(docker create --label vgpu-lavapipe-build=1 "$IMAGE")
docker cp "$container:/out/." "$OUTPUT_DIR/asset"
docker rm "$container" >/dev/null
container=
mv "$OUTPUT_DIR/asset/ldd.txt" "$OUTPUT_DIR/asset/llvm-static-link-libs.txt" \
  "$OUTPUT_DIR/asset/readelf-dynamic.txt" "$OUTPUT_DIR/evidence/"
archive="mesa-lavapipe-${MESA_VERSION}-linux-${ARCH}.tar.gz"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  -C "$OUTPUT_DIR/asset" -czf "$OUTPUT_DIR/$archive" libvulkan_lvp.so lvp_icd.json
(
  cd "$OUTPUT_DIR"
  sha256sum "$archive" > "$archive.sha256"
  cd asset
  sha256sum libvulkan_lvp.so lvp_icd.json > SHA256SUMS
)
printf 'Built %s (%s bytes)\n' "$OUTPUT_DIR/$archive" "$(stat -c %s "$OUTPUT_DIR/$archive")"
