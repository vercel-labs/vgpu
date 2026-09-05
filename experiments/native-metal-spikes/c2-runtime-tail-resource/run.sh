#!/usr/bin/env bash

set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
artifact_dir="$spike_dir/.artifacts"
build_dir="$spike_dir/.build"
consumer_dir="$spike_dir/CrossPackageConsumer"

mkdir -p "$artifact_dir" "$build_dir"

for required_command in swift node rg cmp; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "missing required command: $required_command" >&2
    exit 1
  fi
done

shared_sources=(
  "$spike_dir/Sources/VGPUABI"
  "$spike_dir/Sources/_VGPUBackendSPI"
  "$spike_dir/Sources/VGPUResources"
  "$spike_dir/Sources/GeneratedFixture"
  "$spike_dir/Sources/RecordingProbe"
  "$consumer_dir/Sources/ExternalGeneratedFixture"
  "$consumer_dir/Sources/CrossPackageConsumer"
)

if rg -n '(^|[[:space:]])import[[:space:]]+Metal|\bMTL[A-Za-z0-9_]+' "${shared_sources[@]}"; then
  echo "Metal escaped the MetalProbe target" >&2
  exit 1
fi
if ! rg -q '^import Metal$' "$spike_dir/Sources/MetalProbe/main.swift"; then
  echo "MetalProbe no longer imports Metal" >&2
  exit 1
fi

swift package --package-path "$spike_dir" dump-package > "$artifact_dir/package.json"
swift package --package-path "$consumer_dir" dump-package \
  > "$artifact_dir/cross-package-consumer.json"
cmp \
  "$spike_dir/Sources/GeneratedFixture/GeneratedFixture.swift" \
  "$consumer_dir/Sources/ExternalGeneratedFixture/GeneratedFixture.swift"
node --input-type=module - \
  "$artifact_dir/package.json" \
  "$artifact_dir/cross-package-consumer.json" <<'NODE'
import { readFileSync } from "node:fs";

const packageDescription = JSON.parse(readFileSync(process.argv[2], "utf8"));
const target = packageDescription.targets.find(
  (candidate) => candidate.name === "GeneratedFixture",
);
if (!target) throw new Error("GeneratedFixture target is missing");
const dependencies = target.dependencies.map((dependency) => {
  if (dependency.byName) return dependency.byName[0];
  if (dependency.product) return dependency.product[0];
  return "unknown";
});
if (JSON.stringify(dependencies) !== JSON.stringify(["VGPUABI"])) {
  throw new Error(
    `GeneratedFixture dependencies drifted: ${JSON.stringify(dependencies)}`,
  );
}

const externalPackageDescription = JSON.parse(
  readFileSync(process.argv[3], "utf8"),
);
const externalTarget = externalPackageDescription.targets.find(
  (candidate) => candidate.name === "ExternalGeneratedFixture",
);
if (!externalTarget) throw new Error("ExternalGeneratedFixture target is missing");
const externalDependencies = externalTarget.dependencies.map((dependency) => {
  if (dependency.byName) return dependency.byName[0];
  if (dependency.product) return dependency.product[0];
  return "unknown";
});
if (JSON.stringify(externalDependencies) !== JSON.stringify(["VGPUABI"])) {
  throw new Error(
    `ExternalGeneratedFixture dependencies drifted: ${JSON.stringify(externalDependencies)}`,
  );
}
NODE

common_swift_flags=(
  --package-path "$spike_dir"
  --cache-path "$build_dir/cache"
  --config-path "$build_dir/config"
  --security-path "$build_dir/security"
)

swift build "${common_swift_flags[@]}" \
  --scratch-path "$build_dir/native" \
  --target RecordingProbe
swift build "${common_swift_flags[@]}" \
  --scratch-path "$build_dir/native" \
  --product MetalProbe

swift run "${common_swift_flags[@]}" \
  --scratch-path "$build_dir/native" \
  RecordingProbe > "$artifact_dir/recording-first.json"
swift run "${common_swift_flags[@]}" \
  --scratch-path "$build_dir/native" \
  RecordingProbe > "$artifact_dir/recording-second.json"
cmp "$artifact_dir/recording-first.json" "$artifact_dir/recording-second.json"

node --input-type=module - "$artifact_dir/recording-first.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);
if (!same(report.ranges, [28, 52])) throw new Error("typed ranges drifted");
if (!report.sameBacking.identity || !report.sameBacking.generation) {
  throw new Error("typed views stopped sharing one allocation generation");
}
if (!report.sameBacking.offset) throw new Error("typed view offsets drifted");
if (!report.paddingZero) throw new Error("generated padding is not zero");
for (const label of [
  "backend-atomicity",
  "packer-atomicity",
  "creation-packer-atomicity",
  "element-range-overflow",
  "capacity-hole",
  "descriptor-minimum",
  "range-addition-overflow",
  "range-multiply-overflow",
  "range-round-up-overflow",
  "uint32-range",
  "uint32-factory",
  "uint32-binding",
  "disposed-empty-write",
]) {
  if (!report.negativeChecks.includes(label)) {
    throw new Error(`recording probe omitted ${label}`);
  }
}
if (
  !same(report.suballocation, {
    backingBytes: 88,
    logicalBytes: 52,
    offset: 16,
  })
) {
  throw new Error("suballocation extent drifted");
}
NODE

consumer_output="$(
  swift run \
    --package-path "$consumer_dir" \
    --cache-path "$build_dir/cache" \
    --config-path "$build_dir/config" \
    --security-path "$build_dir/security" \
    --scratch-path "$build_dir/consumer-native" \
    CrossPackageConsumer
)"
if [[ "$consumer_output" != "cross-package/storage/binding" ]]; then
  echo "cross-package ABI consumer drifted: $consumer_output" >&2
  exit 1
fi

for target_triple in arm64-apple-macosx14.0 x86_64-apple-macosx14.0; do
  triple_key="${target_triple%%-*}"
  swift build "${common_swift_flags[@]}" \
    --scratch-path "$build_dir/shared-$triple_key" \
    --triple "$target_triple" \
    --target VGPUResources
  swift build "${common_swift_flags[@]}" \
    --scratch-path "$build_dir/shared-$triple_key" \
    --triple "$target_triple" \
    --target GeneratedFixture
  swift build \
    --package-path "$consumer_dir" \
    --cache-path "$build_dir/cache" \
    --config-path "$build_dir/config" \
    --security-path "$build_dir/security" \
    --scratch-path "$build_dir/consumer-$triple_key" \
    --triple "$target_triple" \
    --target CrossPackageConsumer
done

if [[ "$#" -eq 2 ]]; then
  swift run "${common_swift_flags[@]}" \
    --scratch-path "$build_dir/native" \
    MetalProbe "$1" "$2" > "$artifact_dir/metal.json"
  node --input-type=module - "$artifact_dir/metal.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (
  report.schemaVersion !== 1 ||
  report.gate !== "c2-runtime-tail-resource-metal" ||
  report.status !== "passed"
) {
  throw new Error("Metal probe handshake drifted");
}
if (JSON.stringify(report.readbacks) !== JSON.stringify([[2, 202], [4, 404]])) {
  throw new Error("Metal readback drifted");
}
NODE
  c2_gate_result="portable and Metal gates passed"
elif [[ "$#" -ne 0 ]]; then
  echo "usage: $0 [<library.metallib> <manifest.json>]" >&2
  exit 1
else
  c2_gate_result="portable gates passed; Metal skipped"
fi

echo "c2-runtime-tail-resource: $c2_gate_result"
