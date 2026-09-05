#!/usr/bin/env bash
set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUILD_DIR="$SPIKE_DIR/.build"
ARTIFACT_DIR="$SPIKE_DIR/.artifacts"
PREPARED_DIR="$BUILD_DIR/prepared-runtime"

"$SPIKE_DIR/oracle/run.sh"

for required_command in swift node rg cmp; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "missing required command: $required_command" >&2
    exit 1
  fi
done

mkdir -p "$BUILD_DIR" "$ARTIFACT_DIR"
node "$SPIKE_DIR/scripts/prepare-runtime.mjs" --output "$PREPARED_DIR" >/dev/null

swift format lint --strict --recursive "$PREPARED_DIR/Sources"

if rg -n '(^|[[:space:]])import[[:space:]]+(VGPUResources|VGPUCompute)' \
  "$PREPARED_DIR/Sources/VGPURender"; then
  echo "VGPURender gained a Resources or Compute dependency" >&2
  exit 1
fi

PACKAGE_JSON="$ARTIFACT_DIR/runtime-package.json"
swift package --package-path "$PREPARED_DIR" dump-package > "$PACKAGE_JSON"
node --input-type=module - "$PACKAGE_JSON" <<'NODE'
import { readFileSync } from "node:fs";

const description = JSON.parse(readFileSync(process.argv[2], "utf8"));
const render = description.targets.find(({ name }) => name === "VGPURender");
const dependencies = render?.dependencies.map((dependency) => dependency.byName?.[0]);
if (JSON.stringify(dependencies) !== JSON.stringify([
  "VGPUABI",
  "VGPUCore",
  "_VGPUBackendSPI",
])) {
  throw new Error("VGPURender target boundary drifted");
}
NODE

COMMON_FLAGS=(
  --package-path "$PREPARED_DIR"
  --cache-path "$BUILD_DIR/cache"
  --config-path "$BUILD_DIR/config"
  --security-path "$BUILD_DIR/security"
  --scratch-path "$BUILD_DIR/runtime-native"
  -Xswiftc -strict-concurrency=complete
  -Xswiftc -warnings-as-errors
)

swift build "${COMMON_FLAGS[@]}"
for run in first second; do
  swift run "${COMMON_FLAGS[@]}" DC1RecordingProbe > "$ARTIFACT_DIR/runtime-$run.json"
done
cmp "$ARTIFACT_DIR/runtime-first.json" "$ARTIFACT_DIR/runtime-second.json"

node --input-type=module - "$ARTIFACT_DIR/runtime-first.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
if (
  report.schemaVersion !== 1 ||
  report.gate !== "dc1-compute-draw-recording" ||
  report.status !== "passed" ||
  !same(report.commitTrace, ["computeCommit", "frameCommit"]) ||
  !same(report.renderedArguments, [3, 1, 0, 0]) ||
  !same(report.viewRange, [16, 32]) ||
  report.consumerByteOffset !== 0 ||
  report.physicalByteOffset !== 16 ||
  report.directVertexCount !== 0 ||
  report.nestedSlice !== true ||
  report.sameAllocationGeneration !== true ||
  report.noCPUReadOrWait !== true
) {
  throw new Error("DC1 recording handshake drifted");
}
const expectedFailureCodes = {
  foreignContext: "VGPU-NATIVE-CONTEXT-MISMATCH",
  misalignedOffset: "VGPU-INDIRECT-INVALID",
  missingIndirectUsage: "VGPU-INDIRECT-INVALID",
  offsetOverflow: "VGPU-INDIRECT-INVALID",
  shortRange: "VGPU-INDIRECT-INVALID",
};
for (const [name, expectedCode] of Object.entries(expectedFailureCodes)) {
  const failure = report.synchronousFailures?.[name];
  if (
    failure?.code !== expectedCode ||
    failure?.submissionDelta !== 0 ||
    failure?.tokenDelta !== 0 ||
    failure?.onErrorDelta !== 0
  ) {
    throw new Error(`DC1 negative evidence drifted: ${name}`);
  }
}
NODE

"$SPIKE_DIR/../c2-generated-compute/run.sh"

echo "dc1-compute-draw: oracle, prepared runtime, and C2 regression gates passed"
