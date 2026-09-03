#!/bin/zsh

set -euo pipefail

fixture_dir=${0:A:h}
artifacts_dir="$fixture_dir/.artifacts"
maps_dir="$artifacts_dir/maps"
logs_dir="$artifacts_dir/logs"

mkdir -p "$maps_dir" "$logs_dir"
cd "$fixture_dir"

typeset -A release_binaries
typeset -A external_binaries
typeset -A lto_binaries

build_release() {
  local product=$1
  local scratch="$artifacts_dir/swift/$product"
  local map="$maps_dir/$product.linkmap"

  swift build \
    -c release \
    --product "$product" \
    --scratch-path "$scratch" \
    --explicit-target-dependency-import-check error \
    --enable-dead-strip \
    -Xlinker -map \
    -Xlinker "$map"

  local bin_dir
  bin_dir=$(swift build -c release --scratch-path "$scratch" --show-bin-path)
  release_binaries[$product]="$bin_dir/$product"
}

build_external() {
  local product=$1
  local scratch="$artifacts_dir/external/$product"
  local map="$maps_dir/$product-external.linkmap"

  (
    cd ExternalConsumer
    swift build \
      -c release \
      --product "$product" \
      --scratch-path "$scratch" \
      --explicit-target-dependency-import-check error \
      --enable-dead-strip \
      -Xlinker -map \
      -Xlinker "$map"
  )

  local bin_dir
  bin_dir=$(cd ExternalConsumer && swift build -c release --scratch-path "$scratch" --show-bin-path)
  external_binaries[$product]="$bin_dir/$product"
}

build_lto() {
  local product=$1
  local derived_data="$artifacts_dir/lto/$product"
  local log="$logs_dir/$product-lto.log"
  local architecture
  architecture=$(uname -m)

  if ! xcodebuild \
    -scheme "$product" \
    -configuration Release \
    -destination "platform=macOS,arch=$architecture" \
    -derivedDataPath "$derived_data" \
    ARCHS="$architecture" \
    ONLY_ACTIVE_ARCH=YES \
    SWIFT_COMPILATION_MODE=wholemodule \
    SWIFT_OPTIMIZATION_LEVEL=-Osize \
    LLVM_LTO=YES \
    DEAD_CODE_STRIPPING=YES \
    LD_GENERATE_MAP_FILE=YES \
    build >"$log" 2>&1
  then
    tail -n 80 "$log" >&2
    return 1
  fi

  lto_binaries[$product]="$derived_data/Build/Products/Release/$product"
}

payloads() {
  nm -m "$1" \
    | rg -o '_c0_(core|resource|render|compute)_payload$' \
    | sed 's/_c0_//;s/_payload//' \
    | sort \
    | paste -sd, -
}

assert_payloads() {
  local binary=$1
  local expected=$2
  local actual
  actual=$(payloads "$binary")
  if [[ "$actual" != "$expected" ]]; then
    print -u2 "payload mismatch for ${binary:t}: expected $expected, got $actual"
    return 1
  fi
}

for product in ContextUnified ContextPhysical EffectPhysical ComputePhysical; do
  build_release "$product"
done

for product in ExternalContext ExternalEffect ExternalCompute ExternalFull; do
  build_external "$product"
done

for product in ContextUnified ContextPhysical EffectPhysical ComputePhysical; do
  build_lto "$product"
done

assert_payloads "${release_binaries[ContextUnified]}" compute,core,render,resource
assert_payloads "${release_binaries[ContextPhysical]}" core
assert_payloads "${release_binaries[EffectPhysical]}" core,render,resource
assert_payloads "${release_binaries[ComputePhysical]}" compute,core,resource

assert_payloads "${external_binaries[ExternalContext]}" core
assert_payloads "${external_binaries[ExternalEffect]}" core,render,resource
assert_payloads "${external_binaries[ExternalCompute]}" compute,core,resource
assert_payloads "${external_binaries[ExternalFull]}" compute,core,render,resource

assert_payloads "${lto_binaries[ContextUnified]}" compute,core,render,resource
assert_payloads "${lto_binaries[ContextPhysical]}" core
assert_payloads "${lto_binaries[EffectPhysical]}" core,render,resource
assert_payloads "${lto_binaries[ComputePhysical]}" compute,core,resource

for product in ContextUnified ContextPhysical EffectPhysical ComputePhysical; do
  "${release_binaries[$product]}" >/dev/null
  "${lto_binaries[$product]}" >/dev/null
done

for product in ExternalContext ExternalEffect ExternalCompute ExternalFull; do
  "${external_binaries[$product]}" >/dev/null
done

full_map="$maps_dir/ExternalFull-external.linkmap"
for target in \
  PhysicalMetalCore PhysicalMetalResource PhysicalMetalRender PhysicalMetalCompute
do
  count=$(sed -n '/# Object files:/,/# Sections:/p' "$full_map" \
    | sed -nE 's#.*\/([^/]+)\.build/.*#\1#p' \
    | awk -v target="$target" '$0 == target { count += 1 } END { print count + 0 }')
  if [[ "$count" != 1 ]]; then
    print -u2 "expected one $target object in ExternalFull, found $count"
    exit 1
  fi
done

print
printf '%-24s %s\n' Fixture 'Live payloads'
printf '%-24s %s\n' ContextUnified "$(payloads "${release_binaries[ContextUnified]}")"
printf '%-24s %s\n' ContextPhysical "$(payloads "${release_binaries[ContextPhysical]}")"
printf '%-24s %s\n' EffectPhysical "$(payloads "${release_binaries[EffectPhysical]}")"
printf '%-24s %s\n' ComputePhysical "$(payloads "${release_binaries[ComputePhysical]}")"
printf '%-24s %s\n' ExternalFull "$(payloads "${external_binaries[ExternalFull]}")"
print
print 'C0 linking verification passed'
