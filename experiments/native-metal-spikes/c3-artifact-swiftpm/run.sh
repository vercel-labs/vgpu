#!/usr/bin/env bash

set -euo pipefail

C3_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C3_REPOSITORY="$(cd "$C3_DIR/../../.." && pwd)"
C3_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/vgpu-c3-artifact-swiftpm.XXXXXX")"
C3_NATIVE_ARCH="$(uname -m)"
C3_NODE="$(command -v node)"
C3_REQUIRE_OFFLINE_METAL="${C3_REQUIRE_OFFLINE_METAL:-0}"
C3_METAL_TARGET="${C3_METAL_TARGET:-air64-apple-macos14.0}"
C3_EXPECTED_METAL_TARGET="air64-apple-macos14.0"
C3_POISON_LOG="$C3_SCRATCH/poison.log"
C3_POISON_DIR="$C3_SCRATCH/poison-bin"

cleanup() {
  if [[ -n "${C3_SCRATCH:-}" && -d "$C3_SCRATCH" ]]; then
    rm -rf -- "$C3_SCRATCH"
  fi
}

section() {
  printf '\n== %s ==\n' "$1"
}

fail() {
  printf 'C3 failure: %s\n' "$1" >&2
  exit 1
}

trap cleanup EXIT

case "$C3_NATIVE_ARCH" in
  arm64 | x86_64) ;;
  *) fail "unsupported host architecture $C3_NATIVE_ARCH" ;;
esac

case "$C3_REQUIRE_OFFLINE_METAL" in
  0 | 1) ;;
  *) fail "C3_REQUIRE_OFFLINE_METAL must be 0 or 1" ;;
esac

if [[ "$C3_METAL_TARGET" != "$C3_EXPECTED_METAL_TARGET" ]]; then
  fail "C3_METAL_TARGET must be $C3_EXPECTED_METAL_TARGET to match projection and package minimum macOS 14.0"
fi

mkdir -p "$C3_POISON_DIR"
: >"$C3_POISON_LOG"
for c3_tool in node npx pnpm tint vgpu-tint-compiler metal metallib; do
  ln -s "$C3_DIR/scripts/poison-tool.sh" "$C3_POISON_DIR/$c3_tool"
done

poisoned() {
  C3_POISON_LOG="$C3_POISON_LOG" PATH="$C3_POISON_DIR:$PATH" "$@"
}

assert_poison_unused() {
  if [[ -s "$C3_POISON_LOG" ]]; then
    printf 'Forbidden tools were invoked after generation:\n' >&2
    sort -u "$C3_POISON_LOG" >&2
    exit 1
  fi
}

assert_manifest() {
  local c3_package="$1"
  local c3_expected_dependency="$2"
  local c3_manifest="$3"

  poisoned swift package --package-path "$c3_package" dump-package >"$c3_manifest"
  jq -e \
    --arg dependency "$c3_expected_dependency" \
    '
      .toolsVersion._version == "6.0.0" and
      .platforms == [{"options": [], "platformName": "macos", "version": "14.0"}] and
      .swiftLanguageVersions == ["6"] and
      (.dependencies | length) == 1 and
      (.dependencies[0].fileSystem | length) == 1 and
      (.dependencies[0].fileSystem[0].path | endswith($dependency))
    ' "$c3_manifest" >/dev/null
}

assert_generated_dependency_boundary() {
  local c3_manifest="$1"
  jq -e '
    (.products | length) == 2 and
    ([.products[].name] | sort) == ["AppShaders", "AppShadersC3MetalProbe"] and
    ([.products[] | select(.name == "AppShaders")][0] == {
      name: "AppShaders", settings: [], targets: ["AppShaders"],
      type: {library: ["automatic"]}
    }) and
    ([.products[] | select(.name == "AppShadersC3MetalProbe")][0] == {
      name: "AppShadersC3MetalProbe", settings: [], targets: ["AppShadersC3MetalProbe"],
      type: {executable: null}
    }) and
    (.targets | length) == 3 and
    ([.targets[].name] | sort) == ["AppShaders", "AppShadersC3MetalProbe", "AppShadersTests"] and
    ([.targets[] | select(.name == "AppShaders")][0] | {
      name, type, dependencies, resources, settings, exclude, packageAccess
    }) == {
      name: "AppShaders", type: "regular",
      dependencies: [{product: ["VGPUABI", "RuntimeStub", null, null]}],
      resources: [{path: "Resources", rule: {process: {}}}],
      settings: [], exclude: [], packageAccess: true
    } and
    ([.targets[] | select(.name == "AppShadersC3MetalProbe")][0] | {
      name, type, dependencies, resources, settings, exclude, packageAccess
    }) == {
      name: "AppShadersC3MetalProbe", type: "executable",
      dependencies: [{byName: ["AppShaders", null]}], resources: [],
      settings: [{kind: {linkedFramework: {_0: "Metal"}}, tool: "linker"}],
      exclude: [], packageAccess: true
    } and
    ([.targets[] | select(.name == "AppShadersTests")][0] | {
      name, type, dependencies, resources, settings, exclude, packageAccess
    }) == {
      name: "AppShadersTests", type: "test",
      dependencies: [{byName: ["AppShaders", null]}], resources: [], settings: [],
      exclude: [], packageAccess: true
    } and
    ([.targets[] | .pluginUsages // null] | all(. == null)) and
    (.traits // []) == []
  ' "$c3_manifest" >/dev/null
}

assert_clean_consumer_dependency_boundary() {
  local c3_manifest="$1"
  jq -e '
    .products == [] and
    (.targets | length) == 1 and
    (.targets[0] | {name, type, dependencies, resources, settings, exclude, packageAccess}) == {
      name: "CleanConsumer", type: "executable",
      dependencies: [{byName: ["AppShaders", null]}], resources: [], settings: [],
      exclude: [], packageAccess: true
    } and
    (.targets[0].pluginUsages // null) == null and
    (.traits // []) == []
  ' "$c3_manifest" >/dev/null
}

assert_clean_tree() {
  local c3_root="$1"
  local c3_forbidden
  c3_forbidden="$(find "$c3_root/AppShaders" "$c3_root/CleanConsumer" "$c3_root/RuntimeStub" \
    \( -type d \( -name .build -o -name .swiftpm \) \
       -o -type f \( -name Package.resolved -o -iname '*.wgsl' -o -iname '*.metal' \
         -o -iname '*.msl' -o -iname '*.air' -o -iname '*.js' -o -iname '*.mjs' \
         -o -iname '*.cjs' -o -iname '*tint*' -o -iname '*translator*' \) \) \
    -print)"
  if [[ -n "$c3_forbidden" ]]; then
    printf 'Generated/consumer tree contains forbidden files or residue:\n%s\n' "$c3_forbidden" >&2
    exit 1
  fi
}

build_c3a_architecture() {
  local c3_root="$1"
  local c3_arch="$2"
  local c3_triple="${c3_arch}-apple-macosx"

  poisoned swift build \
    --package-path "$c3_root/AppShaders" \
    --configuration release \
    --triple "$c3_triple" \
    --scratch-path "$C3_SCRATCH/app-shaders-$c3_arch"

  poisoned swift build \
    --package-path "$c3_root/CleanConsumer" \
    --configuration release \
    --triple "$c3_triple" \
    --scratch-path "$C3_SCRATCH/consumer-$c3_arch"

  local c3_binary="$C3_SCRATCH/consumer-$c3_arch/$c3_triple/release/CleanConsumer"
  file "$c3_binary"
  xcrun vtool -show-build "$c3_binary" | grep -E 'platform|minos|sdk'
  xcrun vtool -show-build "$c3_binary" | grep -q 'minos 14.0'
}

section "C3a deterministic assembly"
C3_FIRST="$C3_SCRATCH/assembly-first"
C3_SECOND="$C3_SCRATCH/assembly-second"
"$C3_NODE" "$C3_DIR/scripts/assemble.mjs" --output "$C3_FIRST"
"$C3_NODE" "$C3_DIR/scripts/assemble.mjs" --output "$C3_SECOND"
diff -qr "$C3_FIRST" "$C3_SECOND"
"$C3_NODE" "$C3_DIR/scripts/verify-artifact.mjs" \
  --package "$C3_FIRST/AppShaders" \
  --repository "$C3_REPOSITORY" \
  --inputs-root "$C3_DIR"
C3_FUTURE_MODEL="$C3_SCRATCH/assembly-future-storage-size-model"
"$C3_NODE" "$C3_DIR/scripts/assemble.mjs" \
  --output "$C3_FUTURE_MODEL" \
  --storage-buffer-size-model vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v2
"$C3_NODE" "$C3_DIR/scripts/verify-artifact.mjs" \
  --package "$C3_FUTURE_MODEL/AppShaders" \
  --repository "$C3_REPOSITORY" \
  --inputs-root "$C3_DIR" \
  --expected-storage-buffer-size-model vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v2
assert_clean_tree "$C3_FUTURE_MODEL"
printf 'Future descriptor model did not add itself to fixed runtime support.\n'
printf 'must never be copied by the fixture assembler\n' >"$C3_SECOND/AppShaders/.env"
C3_ALLOWLIST_NEGATIVE_LOG="$C3_SCRATCH/allowlist-negative.log"
if "$C3_NODE" "$C3_DIR/scripts/verify-artifact.mjs" \
  --package "$C3_SECOND/AppShaders" \
  --repository "$C3_REPOSITORY" \
  --inputs-root "$C3_DIR" \
  >"$C3_ALLOWLIST_NEGATIVE_LOG" 2>&1; then
  fail "generated package allowlist accepted an injected .env file"
fi
grep -q 'generated package allowlist' "$C3_ALLOWLIST_NEGATIVE_LOG" \
  || fail "generated package allowlist failed for an unexpected reason"
printf 'Generated package allowlist rejected an injected .env file.\n'
assert_clean_tree "$C3_FIRST"

section "C3a Swift package contracts"
C3_APP_MANIFEST="$C3_SCRATCH/app-shaders-package.json"
C3_CONSUMER_MANIFEST="$C3_SCRATCH/consumer-package.json"
assert_manifest "$C3_FIRST/AppShaders" "/RuntimeStub" "$C3_APP_MANIFEST"
assert_manifest "$C3_FIRST/CleanConsumer" "/AppShaders" "$C3_CONSUMER_MANIFEST"
assert_generated_dependency_boundary "$C3_APP_MANIFEST"
assert_clean_consumer_dependency_boundary "$C3_CONSUMER_MANIFEST"

section "C3a generated package tests"
poisoned swift test \
  --package-path "$C3_FIRST/AppShaders" \
  --configuration release \
  --triple "${C3_NATIVE_ARCH}-apple-macosx" \
  --scratch-path "$C3_SCRATCH/app-shaders-tests"

section "C3a clean consumer architecture builds"
for c3_arch in arm64 x86_64; do
  build_c3a_architecture "$C3_FIRST" "$c3_arch"
done

section "C3a clean consumer execution"
C3_NATIVE_BINARY="$C3_SCRATCH/consumer-$C3_NATIVE_ARCH/${C3_NATIVE_ARCH}-apple-macosx/release/CleanConsumer"
poisoned "$C3_NATIVE_BINARY"

if [[ "$C3_NATIVE_ARCH" == "arm64" ]] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  C3_X86_BINARY="$C3_SCRATCH/consumer-x86_64/x86_64-apple-macosx/release/CleanConsumer"
  poisoned arch -x86_64 "$C3_X86_BINARY"
else
  printf 'Rosetta execution unavailable; the x86_64 cross-build remains a portability signal.\n'
fi

assert_poison_unused
assert_clean_tree "$C3_FIRST"
printf 'C3a passed with an intentionally invalid Metal-library sentinel.\n'

section "C3b optional offline Metal gate"
if ! xcrun --find metallib >/dev/null 2>&1; then
  if [[ "$C3_REQUIRE_OFFLINE_METAL" == "1" ]]; then
    printf 'C3B_TOOLCHAIN_MISSING: metallib is unavailable; no download or installation was attempted.\n' >&2
    exit 1
  fi
  printf 'SKIP C3b: metallib is unavailable; no download or installation was attempted.\n'
  printf '\nC3 result: C3a passed; C3b skipped.\n'
  exit 0
fi

C3_NOOP_AIR="$C3_SCRATCH/noop.air"
C3_RUNTIME_ARRAY_AIR="$C3_SCRATCH/runtime-array.air"
C3_METALLIB="$C3_SCRATCH/AppShaders.metallib"
printf 'Metal target: %s\n' "$C3_METAL_TARGET"
xcrun -sdk macosx metal \
  -std=macos-metal2.4 \
  -target "$C3_METAL_TARGET" \
  -c "$C3_DIR/fixtures/noop.metal" \
  -o "$C3_NOOP_AIR"
xcrun -sdk macosx metal \
  -std=macos-metal2.4 \
  -target "$C3_METAL_TARGET" \
  -c "$C3_DIR/fixtures/runtime-array.metal" \
  -o "$C3_RUNTIME_ARRAY_AIR"
xcrun -sdk macosx metallib \
  "$C3_NOOP_AIR" \
  "$C3_RUNTIME_ARRAY_AIR" \
  -o "$C3_METALLIB"

C3_XCODE_VERSION="$(xcodebuild -version | sed -n '1s/^Xcode //p')"
C3_XCODE_BUILD="$(xcodebuild -version | sed -n '2s/^Build version //p')"
C3_SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
C3_SDK_BUILD="$(xcrun --sdk macosx --show-sdk-build-version)"
C3_SWIFT_VERSION="$(swift --version | sed -nE '1s/.*Swift version ([0-9]+(\.[0-9]+){1,3}).*/\1/p')"
C3_METAL_VERSION_OUTPUT="$(xcrun -sdk macosx metal --version 2>&1 || true)"
C3_METAL_VERSION="$(printf '%s\n' "$C3_METAL_VERSION_OUTPUT" \
  | sed -nE 's/.*[Vv]ersion ([0-9]+(\.[0-9]+){1,3}).*/\1/p' \
  | head -n 1)"

for c3_pair in \
  "xcode:$C3_XCODE_VERSION" \
  "xcode-build:$C3_XCODE_BUILD" \
  "sdk:$C3_SDK_VERSION" \
  "sdk-build:$C3_SDK_BUILD" \
  "swift:$C3_SWIFT_VERSION" \
  "metal:$C3_METAL_VERSION"; do
  if [[ -z "${c3_pair#*:}" ]]; then
    printf 'Unable to record required C3b tool identity (%s). metal --version output:\n%s\n' \
      "${c3_pair%%:*}" "$C3_METAL_VERSION_OUTPUT" >&2
    exit 1
  fi
done

C3_METAL_ROOT="$C3_SCRATCH/assembly-metal"
"$C3_NODE" "$C3_DIR/scripts/assemble.mjs" \
  --output "$C3_METAL_ROOT" \
  --payload "$C3_METALLIB" \
  --payload-kind metal-library \
  --metal-target "$C3_METAL_TARGET" \
  --metal-language-version 2.4 \
  --xcode-version "$C3_XCODE_VERSION" \
  --xcode-build "$C3_XCODE_BUILD" \
  --metal-version "$C3_METAL_VERSION" \
  --swift-version "$C3_SWIFT_VERSION" \
  --sdk-version "$C3_SDK_VERSION" \
  --sdk-build "$C3_SDK_BUILD"
"$C3_NODE" "$C3_DIR/scripts/verify-artifact.mjs" \
  --package "$C3_METAL_ROOT/AppShaders" \
  --repository "$C3_REPOSITORY" \
  --inputs-root "$C3_DIR"
assert_clean_tree "$C3_METAL_ROOT"

: >"$C3_POISON_LOG"
poisoned swift build \
  --package-path "$C3_METAL_ROOT/AppShaders" \
  --configuration release \
  --product AppShadersC3MetalProbe \
  --triple "${C3_NATIVE_ARCH}-apple-macosx" \
  --scratch-path "$C3_SCRATCH/metal-probe"
C3_PROBE="$C3_SCRATCH/metal-probe/${C3_NATIVE_ARCH}-apple-macosx/release/AppShadersC3MetalProbe"
poisoned "$C3_PROBE" --metal-readback
assert_poison_unused
assert_clean_tree "$C3_METAL_ROOT"

printf '\nC3 result: C3a and C3b passed.\n'
