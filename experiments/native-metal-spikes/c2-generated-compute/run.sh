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

swift format lint --strict --recursive "$spike_dir/Sources" "$consumer_dir/Sources"

neutral_sources=(
  "$spike_dir/Sources/VGPUABI"
  "$spike_dir/Sources/_VGPUBackendSPI"
  "$spike_dir/Sources/VGPUCore"
  "$spike_dir/Sources/VGPUResources"
  "$spike_dir/Sources/VGPUCompute"
  "$spike_dir/Sources/GeneratedFixture"
  "$spike_dir/Sources/RecordingProbe"
)

if rg -n \
  '(^|[[:space:]])import[[:space:]]+Metal|\bMTL[A-Za-z0-9_]+|vgpu-metal-|immediateDataByteOffset|buffer\(30\)' \
  "${neutral_sources[@]}"; then
  echo "a physical Metal concept escaped into a neutral target" >&2
  exit 1
fi
if rg -n 'metallibURL|manifestURL' \
  "$spike_dir/Sources/_VGPUMetalCoreImpl" \
  "$spike_dir/Sources/_VGPUMetalResourcesImpl" \
  "$spike_dir/Sources/_VGPUMetalComputeImpl"; then
  echo "artifact URL resolution escaped VGPUTesting" >&2
  exit 1
fi

swift package --package-path "$spike_dir" dump-package > "$artifact_dir/package.json"
swift package --package-path "$consumer_dir" dump-package > "$artifact_dir/consumer-package.json"
cmp \
  "$spike_dir/Sources/GeneratedFixture/GeneratedFixture.swift" \
  "$consumer_dir/Sources/ExternalGeneratedFixture/GeneratedFixture.swift"
node --input-type=module - \
  "$artifact_dir/package.json" \
  "$artifact_dir/consumer-package.json" <<'NODE'
import { readFileSync } from "node:fs";

const description = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (description.dependencies.length !== 0) {
  throw new Error("the isolated spike gained an external package dependency");
}
const dependencyNames = (targetName) => {
  const target = description.targets.find(({ name }) => name === targetName);
  if (!target) throw new Error(`missing target: ${targetName}`);
  return target.dependencies.map((dependency) => {
    if (dependency.byName) return dependency.byName[0];
    if (dependency.product) return dependency.product[0];
    return "unknown";
  });
};
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);
if (!same(dependencyNames("GeneratedFixture"), ["VGPUABI"])) {
  throw new Error("GeneratedFixture must depend exactly on VGPUABI");
}
if (!same(dependencyNames("VGPUCompute"), ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"])) {
  throw new Error("VGPUCompute target boundary drifted");
}
if (!same(dependencyNames("VGPUResources"), ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"])) {
  throw new Error("VGPUResources target boundary drifted");
}
for (const target of [
  "_VGPUMetalCoreImpl",
  "_VGPUMetalResourcesImpl",
  "_VGPUMetalComputeImpl",
  "VGPUTesting",
]) {
  if (!description.targets.some(({ name }) => name === target)) {
    throw new Error(`physical split target is missing: ${target}`);
  }
}
const consumer = JSON.parse(readFileSync(process.argv[3], "utf8"));
const external = consumer.targets.find(({ name }) => name === "ExternalGeneratedFixture");
if (!external) throw new Error("external generated target is missing");
const externalDependencies = external.dependencies.map((dependency) =>
  dependency.product ? dependency.product[0] : "unknown",
);
if (!same(externalDependencies, ["VGPUABI"])) {
  throw new Error("external generated fixture must depend exactly on VGPUABI");
}
NODE

common_flags=(
  --package-path "$spike_dir"
  --cache-path "$build_dir/cache"
  --config-path "$build_dir/config"
  --security-path "$build_dir/security"
  -Xswiftc -strict-concurrency=complete
  -Xswiftc -warnings-as-errors
)

swift build "${common_flags[@]}" \
  --scratch-path "$build_dir/native" \
  --product RecordingProbe
swift build "${common_flags[@]}" \
  --scratch-path "$build_dir/native" \
  --product MetalProbe

for run in first second; do
  swift run "${common_flags[@]}" \
    --scratch-path "$build_dir/native" \
    RecordingProbe > "$artifact_dir/recording-$run.json"
done
cmp "$artifact_dir/recording-first.json" "$artifact_dir/recording-second.json"

consumer_output="$(
  swift run \
    --package-path "$consumer_dir" \
    --cache-path "$build_dir/cache" \
    --config-path "$build_dir/config" \
    --security-path "$build_dir/security" \
    --scratch-path "$build_dir/consumer-native" \
    -Xswiftc -strict-concurrency=complete \
    -Xswiftc -warnings-as-errors \
    CrossPackageConsumer
)"
if [[ "$consumer_output" != "cross-package/generated-compute" ]]; then
  echo "cross-package generated consumer drifted: $consumer_output" >&2
  exit 1
fi

node --input-type=module - "$artifact_dir/recording-first.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);
if (
  report.schemaVersion !== 1 ||
  report.gate !== "c2-generated-compute-recording" ||
  report.status !== "passed"
) {
  throw new Error("recording handshake drifted");
}
if (!same(report.effectiveRanges, [28, 52])) {
  throw new Error("recording ranges drifted");
}
if (!same(report.readbacks, [[2, 202], [4, 404]])) {
  throw new Error("recording readbacks drifted");
}
for (const key of [
  "accessGateFailFast",
  "accessGateStackReentrancy",
  "atomicSetRollback",
  "contextClosesChildren",
  "deferredErrorDelivery",
  "generationReleaseAfterCompletion",
  "runtimeLayoutValidation",
  "sameBackingGeneration",
  "settledRegistrationLinearization",
  "synchronousSubmitRollback",
  "unobservedDiagnostic",
]) {
  if (report[key] !== true) throw new Error(`recording check failed: ${key}`);
}
NODE

for target_triple in arm64-apple-macosx14.0 x86_64-apple-macosx14.0; do
  triple_key="${target_triple%%-*}"
  for target in VGPUResources VGPUCompute GeneratedFixture; do
    swift build "${common_flags[@]}" \
      --scratch-path "$build_dir/$triple_key" \
      --triple "$target_triple" \
      --target "$target"
  done
  swift build \
    --package-path "$consumer_dir" \
    --cache-path "$build_dir/cache" \
    --config-path "$build_dir/config" \
    --security-path "$build_dir/security" \
    --scratch-path "$build_dir/consumer-$triple_key" \
    --triple "$target_triple" \
    -Xswiftc -strict-concurrency=complete \
    -Xswiftc -warnings-as-errors \
    --target CrossPackageConsumer
done

if [[ "$#" -eq 2 ]]; then
  for run in first second; do
    swift run "${common_flags[@]}" \
      --scratch-path "$build_dir/native" \
      MetalProbe "$1" "$2" > "$artifact_dir/metal-$run.json"
  done
  cmp "$artifact_dir/metal-first.json" "$artifact_dir/metal-second.json"
  node --input-type=module - "$artifact_dir/metal-first.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const same = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);
if (
  report.schemaVersion !== 1 ||
  report.gate !== "c2-generated-compute-metal" ||
  report.status !== "passed"
) {
  throw new Error("Metal handshake drifted");
}
if (!same(report.readbacks, [[2, 202], [4, 404]])) {
  throw new Error("Metal readbacks drifted");
}
if (!same(report.effectiveRanges, [28, 52])) {
  throw new Error("Metal ranges drifted");
}
if (!same(report.immediateUploads, [[0, 28], [0, 52]])) {
  throw new Error("Metal immediate-data transport drifted");
}
if (report.sameBackingBuffer !== true || report.generationReleaseAfterCompletion !== true) {
  throw new Error("Metal lifetime identity drifted");
}
NODE
  result="portable and Metal gates passed"
elif [[ "$#" -ne 0 ]]; then
  echo "usage: $0 [<library.metallib> <manifest.json>]" >&2
  exit 1
else
  result="portable gates passed; Metal skipped"
fi

echo "c2-generated-compute: $result"
