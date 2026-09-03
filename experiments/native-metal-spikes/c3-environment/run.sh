#!/usr/bin/env bash

set -euo pipefail

C3_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C3_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/vgpu-c3-environment.XXXXXX")"
C3_SDK="$(xcrun --sdk macosx --show-sdk-path)"
C3_NATIVE_ARCH="$(uname -m)"

cleanup() {
  if [[ -n "${C3_SCRATCH:-}" && -d "$C3_SCRATCH" ]]; then
    rm -rf -- "$C3_SCRATCH"
  fi
}

section() {
  printf '\n== %s ==\n' "$1"
}

trap cleanup EXIT

case "$C3_NATIVE_ARCH" in
  arm64 | x86_64) ;;
  *)
    printf 'Unsupported host architecture for this probe: %s\n' "$C3_NATIVE_ARCH" >&2
    exit 1
    ;;
esac

section "Host and selected toolchain"
sw_vers
printf 'architecture: %s\n' "$C3_NATIVE_ARCH"
xcode-select -p
xcodebuild -version
printf 'macOS SDK: %s (build %s)\n' \
  "$(xcrun --sdk macosx --show-sdk-version)" \
  "$(xcrun --sdk macosx --show-sdk-build-version)"
swift --version

section "Swift package contract"
C3_MANIFEST_JSON="$C3_SCRATCH/package.json"
swift package --package-path "$C3_DIR" dump-package >"$C3_MANIFEST_JSON"
grep -A1 '"platformName" : "macos"' "$C3_MANIFEST_JSON"
grep -A2 '"toolsVersion"' "$C3_MANIFEST_JSON"

for c3_arch in arm64 x86_64; do
  c3_triple="${c3_arch}-apple-macosx"
  c3_build="$C3_SCRATCH/spm-$c3_arch"
  swift build \
    --package-path "$C3_DIR" \
    --configuration release \
    --triple "$c3_triple" \
    --scratch-path "$c3_build"

  c3_binary="$c3_build/$c3_triple/release/C3EnvironmentProbe"
  file "$c3_binary"
  xcrun vtool -show-build "$c3_binary" \
    | grep -E 'platform|minos|sdk'
done

section "Native execution"
"$C3_SCRATCH/spm-$C3_NATIVE_ARCH/${C3_NATIVE_ARCH}-apple-macosx/release/C3EnvironmentProbe"

if [[ "$C3_NATIVE_ARCH" == "arm64" ]] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  section "Optional Rosetta execution"
  "$C3_SCRATCH/spm-x86_64/x86_64-apple-macosx/release/C3EnvironmentProbe"
else
  printf 'Rosetta execution unavailable; the x86_64 cross-build result remains valid.\n'
fi

section "Swift concurrency surface"
for c3_arch in arm64 x86_64; do
  swiftc \
    -typecheck \
    -parse-as-library \
    -swift-version 6 \
    -strict-concurrency=complete \
    -target "${c3_arch}-apple-macosx14.0" \
    -sdk "$C3_SDK" \
    "$C3_DIR/IsolationPositive.swift"
done

C3_NEGATIVE_LOG="$C3_SCRATCH/isolation-negative.log"
if swiftc \
  -typecheck \
  -parse-as-library \
  -swift-version 6 \
  -strict-concurrency=complete \
  -target "${C3_NATIVE_ARCH}-apple-macosx14.0" \
  -sdk "$C3_SDK" \
  "$C3_DIR/IsolationNegative.swift" \
  >"$C3_NEGATIVE_LOG" 2>&1; then
  printf 'Expected IsolationNegative.swift to fail type checking.\n' >&2
  exit 1
fi

if ! grep -q 'non-Sendable' "$C3_NEGATIVE_LOG"; then
  printf 'Negative fixture failed for an unexpected reason:\n' >&2
  cat "$C3_NEGATIVE_LOG" >&2
  exit 1
fi
printf 'IsolationNegative.swift rejected its non-Sendable capture as expected.\n'

swiftc \
  -parse-as-library \
  -swift-version 6 \
  -strict-concurrency=complete \
  -target "${C3_NATIVE_ARCH}-apple-macosx14.0" \
  -sdk "$C3_SDK" \
  "$C3_DIR/IsolationRuntime.swift" \
  -o "$C3_SCRATCH/isolation-runtime"
"$C3_SCRATCH/isolation-runtime"
xcrun vtool -show-build "$C3_SCRATCH/isolation-runtime" \
  | grep -E 'platform|minos|sdk'

section "Metal compiler and linker"
xcodebuild -showComponent MetalToolchain -json || true
printf '\n'
if xcrun --find metallib >/dev/null 2>&1; then
  xcrun -sdk macosx metal \
    -c "$C3_DIR/minimal.metal" \
    -o "$C3_SCRATCH/minimal.air"
  xcrun -sdk macosx metallib \
    "$C3_SCRATCH/minimal.air" \
    -o "$C3_SCRATCH/minimal.metallib"
  printf 'Metal compile and link passed.\n'
else
  printf 'SKIP: downloadable MetalToolchain is unavailable; no installation was attempted.\n'
fi

section "Result"
printf 'Swift environment checks passed. Build products were isolated in a temporary directory.\n'
