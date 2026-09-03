#!/usr/bin/env bash
set -euo pipefail

C2_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$C2_DIR/../../.." && pwd)"
BUILD_DIR="$C2_DIR/.build"
ARTIFACTS_DIR="$C2_DIR/.artifacts"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "C2 SKIP: the Swift package targets macOS 14 or newer." >&2
  exit 0
fi

for prerequisite in node swift cmp; do
  if ! command -v "$prerequisite" >/dev/null 2>&1; then
    echo "C2 ERROR: missing prerequisite '$prerequisite'; the runner installs nothing." >&2
    exit 2
  fi
done

if [[ ! -x "$ESBUILD" ]]; then
  echo "C2 ERROR: repository esbuild is missing at node_modules/.bin/esbuild; the runner installs nothing." >&2
  exit 2
fi
if [[ ! -f "$REPO_ROOT/packages/vgpu-api/src/set-packing.ts" ]]; then
  echo "C2 ERROR: expected to run from experiments/native-metal-spikes/c2-binding-abi in the vgpu repository." >&2
  exit 2
fi

mkdir -p "$BUILD_DIR" "$ARTIFACTS_DIR"

SWIFT_PATHS=(
  --package-path "$C2_DIR"
  --scratch-path "$BUILD_DIR/swiftpm"
  --cache-path "$BUILD_DIR/swiftpm-cache"
  --config-path "$BUILD_DIR/swiftpm-config"
  --security-path "$BUILD_DIR/swiftpm-security"
)

cd "$REPO_ROOT"
"$ESBUILD" "$C2_DIR/oracle-entry.ts" \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile="$BUILD_DIR/oracle.mjs" \
  --log-level=warning

node "$BUILD_DIR/oracle.mjs" "$C2_DIR/fixtures/cases.json" "$ARTIFACTS_DIR/typescript-oracle.json"
cp "$ARTIFACTS_DIR/typescript-oracle.json" "$BUILD_DIR/typescript-oracle.first.json"
node "$BUILD_DIR/oracle.mjs" "$C2_DIR/fixtures/cases.json" "$ARTIFACTS_DIR/typescript-oracle.json"
cmp "$BUILD_DIR/typescript-oracle.first.json" "$ARTIFACTS_DIR/typescript-oracle.json"

swift run \
  "${SWIFT_PATHS[@]}" \
  -c release \
  C2ABIProbe \
  "$C2_DIR/fixtures/cases.json" \
  "$ARTIFACTS_DIR/typescript-oracle.json" \
  "$ARTIFACTS_DIR/swift-results.json"
cp "$ARTIFACTS_DIR/swift-results.json" "$BUILD_DIR/swift-results.first.json"
swift run \
  "${SWIFT_PATHS[@]}" \
  -c release \
  C2ABIProbe \
  "$C2_DIR/fixtures/cases.json" \
  "$ARTIFACTS_DIR/typescript-oracle.json" \
  "$ARTIFACTS_DIR/swift-results.json"
cmp "$BUILD_DIR/swift-results.first.json" "$ARTIFACTS_DIR/swift-results.json"

if [[ "${C2_TEST_X86:-0}" == "1" ]]; then
  swift build \
    --package-path "$C2_DIR" \
    --scratch-path "$BUILD_DIR/swiftpm-x86" \
    --cache-path "$BUILD_DIR/swiftpm-x86-cache" \
    --config-path "$BUILD_DIR/swiftpm-x86-config" \
    --security-path "$BUILD_DIR/swiftpm-x86-security" \
    -c release \
    --triple x86_64-apple-macosx14.0
  "$BUILD_DIR/swiftpm-x86/x86_64-apple-macosx/release/C2ABIProbe" \
    "$C2_DIR/fixtures/cases.json" \
    "$ARTIFACTS_DIR/typescript-oracle.json" \
    "$BUILD_DIR/swift-x86-results.json"
  cmp "$ARTIFACTS_DIR/swift-results.json" "$BUILD_DIR/swift-x86-results.json"
fi

node "$C2_DIR/gpu-readback.mjs" \
  "$ARTIFACTS_DIR/swift-results.json" \
  "$ARTIFACTS_DIR/gpu-readback.json"

node "$C2_DIR/verify-snapshot.mjs" \
  "$C2_DIR/expected/snapshot.json" \
  "$ARTIFACTS_DIR/typescript-oracle.json" \
  "$ARTIFACTS_DIR/swift-results.json" \
  "$ARTIFACTS_DIR/gpu-readback.json"
