#!/bin/bash

set -Eeuo pipefail

on_error() {
  local status=$?
  echo "dc1-compute-draw: connected probe failed at line ${BASH_LINENO[0]}" >&2
  exit "$status"
}
trap on_error ERR

if [[ $# -ne 2 ]]; then
  echo "usage: probe.sh <library.metallib> <dc1-handoff.json>" >&2
  exit 64
fi

spike_dir="$(cd "$(dirname "$0")" && pwd)"
library=$1
handoff=$2

for command_name in node swift jq diff shasum find rg cmp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "dc1-compute-draw: required command is missing: $command_name" >&2
    exit 1
  fi
done
if [[ ! -f "$library" || -L "$library" || ! -f "$handoff" || -L "$handoff" ]]; then
  echo "dc1-compute-draw: inputs must be regular, non-symlink files" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/vgpu-dc1-connected.XXXXXX")"
mkdir -p "$spike_dir/.build"
prepared_runtime="$(mktemp -d "$spike_dir/.build/connected-runtime.XXXXXX")"
trap 'rm -rf "$scratch" "$prepared_runtime"' EXIT

node "$spike_dir/scripts/assemble.mjs" \
  --library "$library" \
  --handoff "$handoff" \
  --output "$scratch/assembly-a" >"$scratch/assembly-a.json"
node "$spike_dir/scripts/assemble.mjs" \
  --library "$library" \
  --handoff "$handoff" \
  --output "$scratch/assembly-b" >"$scratch/assembly-b.json"

diff -q "$scratch/assembly-a.json" "$scratch/assembly-b.json" >/dev/null
diff -qr "$scratch/assembly-a/AppShaders" "$scratch/assembly-b/AppShaders" >/dev/null

cp -R "$scratch/assembly-a" "$scratch/relocated"
assembly="$scratch/relocated"
cp -R "$spike_dir/templates/CleanConsumer" "$assembly/CleanConsumer"
cp -R "$spike_dir/templates/AuditConsumer" "$assembly/AuditConsumer"
node "$spike_dir/scripts/prepare-runtime.mjs" --output "$prepared_runtime/runtime" \
  >"$scratch/runtime-preparation.json"
cp -R "$prepared_runtime/runtime" "$assembly/RuntimePrototype"

app_package="$scratch/app-package.json"
clean_package="$scratch/clean-package.json"
audit_package="$scratch/audit-package.json"
runtime_package="$scratch/runtime-package.json"
swift package --package-path "$assembly/AppShaders" dump-package \
  >"$app_package" 2>"$scratch/app-package.stderr"
swift package --package-path "$assembly/CleanConsumer" dump-package \
  >"$clean_package" 2>"$scratch/clean-package.stderr"
swift package --package-path "$assembly/AuditConsumer" dump-package \
  >"$audit_package" 2>"$scratch/audit-package.stderr"
swift package --package-path "$assembly/RuntimePrototype" dump-package \
  >"$runtime_package" 2>"$scratch/runtime-package.stderr"
if [[ -s "$scratch/app-package.stderr" || -s "$scratch/clean-package.stderr" || \
  -s "$scratch/audit-package.stderr" || -s "$scratch/runtime-package.stderr" ]]; then
  echo "dc1-compute-draw: SwiftPM package inspection wrote stderr" >&2
  exit 1
fi

jq -e '
  .products == [{"name":"AppShaders","settings":[],"targets":["AppShaders"],"type":{"library":["automatic"]}}]
  and ([.targets[] | select(.name == "AppShaders") | .dependencies[].product[0]] == ["VGPUABI"])
  and ([.targets[] | select(.name == "AppShaders") | .resources[].path] == ["Resources"])
' "$app_package" >/dev/null
jq -e '
  ([.targets[] | select(.name == "CleanConsumer") | .dependencies[] |
    if has("product") then .product[0] else empty end] | sort)
  == (["AppShaders", "VGPUMetalCompute", "VGPUMetalRender"] | sort)
' "$clean_package" >/dev/null
jq -e '
  ([.targets[] | select(.name == "AuditConsumer") | .dependencies[] |
    if has("product") then .product[0] else empty end] | sort)
  == (["AppShaders", "VGPUMetalCompute", "VGPUMetalRender", "VGPUTesting"] | sort)
' "$audit_package" >/dev/null
jq -e '
  def targetDependencies($name):
    [.targets[] | select(.name == $name) | .dependencies[] |
      if has("byName") then .byName[0]
      elif has("target") then .target[0]
      elif has("product") then .product[0]
      else empty end];
  def productTargets($name):
    [.products[] | select(.name == $name) | .targets[]];
  targetDependencies("VGPURender") == ["VGPUABI","VGPUCore","_VGPUBackendSPI"]
  and targetDependencies("_VGPUMetalResourcesImpl") ==
    ["VGPUABI","_VGPUBackendSPI","_VGPUMetalCoreImpl"]
  and targetDependencies("_VGPUMetalProgramImpl") ==
    ["VGPUABI","_VGPUBackendSPI","_VGPUMetalCoreImpl"]
  and targetDependencies("_VGPUMetalComputeImpl") ==
    ["VGPUABI","_VGPUBackendSPI","_VGPUMetalCoreImpl","_VGPUMetalResourcesImpl","_VGPUMetalProgramImpl"]
  and targetDependencies("_VGPUMetalRenderImpl") ==
    ["VGPUABI","_VGPUBackendSPI","_VGPUMetalCoreImpl","_VGPUMetalResourcesImpl","_VGPUMetalProgramImpl"]
  and productTargets("VGPUMetalResources") ==
    ["VGPUABI","VGPUCore","VGPUResources","VGPUMetal","_VGPUMetalCoreImpl","_VGPUMetalResourcesImpl"]
  and productTargets("VGPUMetalCompute") ==
    ["VGPUABI","VGPUCore","VGPUResources","VGPUCompute","VGPUMetal","_VGPUMetalCoreImpl","_VGPUMetalResourcesImpl","_VGPUMetalProgramImpl","_VGPUMetalComputeImpl"]
  and productTargets("VGPUMetalRender") ==
    ["VGPUABI","VGPUCore","VGPUResources","VGPURender","VGPUMetal","_VGPUMetalCoreImpl","_VGPUMetalResourcesImpl","_VGPUMetalProgramImpl","_VGPUMetalRenderImpl"]
  and (productTargets("VGPUMetalCompute") | all(contains("Render") | not))
  and (productTargets("VGPUMetalRender") | all(contains("Compute") | not))
' "$runtime_package" >/dev/null

generated="$assembly/AppShaders/Sources/AppShaders/AppShaders.generated.swift"
artifact="$assembly/AppShaders/Sources/AppShaders/Resources/AppShaders.artifact.json"
bundled_library="$assembly/AppShaders/Sources/AppShaders/Resources/AppShaders.metallib"
clean_source="$assembly/CleanConsumer/Sources/CleanConsumer/main.swift"
audit_source="$assembly/AuditConsumer/Sources/AuditConsumer/main.swift"

if rg -n '^import (Metal|VGPUCore|VGPUResources|VGPUCompute|VGPURender|VGPUMetal|VGPUTesting|_VGPU)' "$generated" >/dev/null; then
  echo "dc1-compute-draw: AppShaders imports a runtime or backend module" >&2
  exit 1
fi
if rg -n '^import (VGPUABI|VGPUTesting|_VGPU)' "$clean_source" >/dev/null; then
  echo "dc1-compute-draw: clean consumer crosses an ABI, internal, or testing boundary" >&2
  exit 1
fi
if ! rg -q '^import VGPUTesting$' "$audit_source"; then
  echo "dc1-compute-draw: audit consumer does not declare its testing boundary" >&2
  exit 1
fi
if [[ "$(rg -c '^private enum ArtifactWitness:' "$generated")" -ne 1 ]] || \
  [[ "$(rg -c '^private let sharedArtifact =' "$generated")" -ne 1 ]]; then
  echo "dc1-compute-draw: generated programs do not share one private artifact witness" >&2
  exit 1
fi
if rg -n '\b(Tint|WGSL|MSL|AIR|Node|pnpm|npx)\b' \
  "$assembly/AppShaders" "$assembly/CleanConsumer" >/dev/null; then
  echo "dc1-compute-draw: generated or clean-consumer source leaked a toolchain dependency" >&2
  exit 1
fi
forbidden_path="$(find "$assembly/AppShaders" "$assembly/CleanConsumer" \
  \( -type d -name node_modules -o -type f \( \
    -iname '*.wgsl' -o -iname '*.metal' -o -iname '*.msl' -o \
    -iname '*.air' -o -iname '*.js' -o -iname '*.mjs' -o -iname '*.cjs' \
  \) \) -print -quit)"
if [[ -n "$forbidden_path" ]]; then
  echo "dc1-compute-draw: generated package contains a source/compiler artifact" >&2
  exit 1
fi

descriptor_sha256="$(shasum -a 256 "$artifact" | awk '{print $1}')"
library_sha256="$(shasum -a 256 "$bundled_library" | awk '{print $1}')"
cmp -s "$library" "$bundled_library"
if [[ "$(tail -c 1 "$artifact" | od -An -t x1 | tr -d '[:space:]')" != "0a" ]]; then
  echo "dc1-compute-draw: artifact descriptor has no final newline" >&2
  exit 1
fi
jq -e --arg library "$library_sha256" '
  ([keys[]] | sort) == (["abi","artifactID","contractId","evidence","library","programs","schemaVersion","semantic"] | sort)
  and .schemaVersion == 1
  and .contractId == "vgpu-native-dc1-compute-draw-artifact/v1"
  and .artifactID == "dc1-compute-draw"
  and .abi == {
    bindingLayoutABI: 1,
    generatedSwiftABI: 1,
    metalProjectionABI: 1,
    requiredVGPUABIVersion: 1,
    semanticSchemaVersion: 1
  }
  and .library == {sha256: $library}
  and .evidence.metallibSha256 == $library
  and ([.programs[].programID] == ["ConsumePacket", "ProducePacket"])
  and .programs[0].entryPointIDs == {fragment:"fragmentMain",vertex:"vertexMain"}
  and .programs[1].entryPointIDs == {compute:"produce"}
  and ([.programs[].runtimeManifest.semanticProgram] == ["ConsumePacket", "ProducePacket"])
  and ([.programs[].runtimeManifest.kind] == ["draw", "compute"])
  and ([.programs[0].runtimeManifest.entryPoints[].metal] == ["vgpu_dc1_vertex", "vgpu_dc1_fragment"])
  and ([.programs[1].runtimeManifest.entryPoints[].metal] == ["vgpu_dc1_produce"])
  and (.programs[0].runtimeManifest.bindings == [])
  and ([.programs[1].runtimeManifest.bindings[].semanticBinding] == ["g0b0"])
  and ([.programs[1].runtimeManifest.bindings[].descriptor.minimumBindingSize] == [32])
  and ([.programs[1].runtimeManifest.bindings[].descriptor.runtimeSized] == [false])
  and (.programs[0].runtimeManifest.internalBindings == [])
  and (.programs[1].runtimeManifest.internalBindings == [])
  and (.programs[0].runtimeManifest.storageBufferSizeRegions == [])
  and (.programs[1].runtimeManifest.storageBufferSizeRegions == [])
' "$artifact" >/dev/null
jq -e --arg descriptor "$descriptor_sha256" --arg library "$library_sha256" '
  ([keys[]] | sort) == (["artifactID","descriptorSHA256","librarySHA256","programs","schemaVersion","semanticSHA256"] | sort)
  and .schemaVersion == 1
  and .artifactID == "dc1-compute-draw"
  and .descriptorSHA256 == $descriptor
  and .librarySHA256 == $library
  and ([.programs[].programID] == ["ConsumePacket", "ProducePacket"])
' "$scratch/assembly-a.json" >/dev/null
rg -Fq "_vgpuDescriptorSHA256 = \"$descriptor_sha256\"" "$generated"
rg -Fq "_vgpuLibrarySHA256 = \"$library_sha256\"" "$generated"

for mutation in abi artifact-id entry-point fixed-layout fractional-integer model program-order unicode-digest unknown; do
  cp "$artifact" "$scratch/$mutation-artifact.json"
  cp "$generated" "$scratch/$mutation-generated.swift"
  node "$spike_dir/scripts/mutate-artifact.mjs" \
    --artifact "$scratch/$mutation-artifact.json" \
    --generated "$scratch/$mutation-generated.swift" \
    --mutation "$mutation" >"$scratch/$mutation-mutation.json"
done

poison="$scratch/poison"
mkdir "$poison"
poison_log="$scratch/poison.log"
: >"$poison_log"
if [[ ! -x "$spike_dir/scripts/poison-tool.sh" ]]; then
  echo "dc1-compute-draw: poison helper is not executable" >&2
  exit 1
fi
for tool_name in node npx pnpm tint vgpu-tint-worker metal metallib; do
  ln -s "$spike_dir/scripts/poison-tool.sh" "$poison/$tool_name"
done
export DC1_POISON_LOG="$poison_log"
export PATH="$poison:$PATH"

build_package() {
  local package_path=$1
  local build_path=$2
  local label=$3
  shift 3
  if ! swift build \
    --package-path "$package_path" \
    --scratch-path "$build_path" \
    -c release \
    -Xswiftc -strict-concurrency=complete \
    -Xswiftc -warnings-as-errors \
    "$@" >"$scratch/$label.stdout" 2>"$scratch/$label.stderr"; then
    echo "dc1-compute-draw: $label failed" >&2
    cat "$scratch/$label.stdout" >&2
    cat "$scratch/$label.stderr" >&2
    return 1
  fi
  if [[ -s "$scratch/$label.stderr" ]]; then
    echo "dc1-compute-draw: $label wrote stderr" >&2
    cat "$scratch/$label.stderr" >&2
    exit 1
  fi
}

build_package "$assembly/CleanConsumer" "$scratch/build-clean" build-clean
build_package "$assembly/CleanConsumer" "$scratch/build-clean-x86_64" build-clean-x86_64 \
  --triple x86_64-apple-macosx
build_package "$assembly/AuditConsumer" "$scratch/build-audit" build-audit
build_package "$assembly/RuntimePrototype" "$scratch/build-recording" build-recording \
  --product DC1RecordingProbe

binary_for() {
  local package_path=$1
  local build_path=$2
  local executable=$3
  local stderr_path=$4
  local bin_directory
  bin_directory="$(swift build \
    --package-path "$package_path" \
    --scratch-path "$build_path" \
    -c release --show-bin-path 2>"$stderr_path")"
  if [[ -s "$stderr_path" ]]; then
    echo "dc1-compute-draw: binary path query wrote stderr" >&2
    exit 1
  fi
  printf '%s/%s' "$bin_directory" "$executable"
}

clean_binary="$(binary_for "$assembly/CleanConsumer" "$scratch/build-clean" CleanConsumer "$scratch/clean-bin.stderr")"
audit_binary="$(binary_for "$assembly/AuditConsumer" "$scratch/build-audit" AuditConsumer "$scratch/audit-bin.stderr")"
recording_binary="$(binary_for "$assembly/RuntimePrototype" "$scratch/build-recording" DC1RecordingProbe "$scratch/recording-bin.stderr")"

for run in first second; do
  if ! "$clean_binary" >"$scratch/clean-$run.json" 2>"$scratch/clean-$run.stderr"; then
    echo "dc1-compute-draw: clean consumer failed" >&2
    cat "$scratch/clean-$run.stderr" >&2
    exit 1
  fi
  if ! "$audit_binary" >"$scratch/audit-$run.json" 2>"$scratch/audit-$run.stderr"; then
    echo "dc1-compute-draw: audit consumer failed" >&2
    cat "$scratch/audit-$run.stderr" >&2
    exit 1
  fi
  if ! "$recording_binary" >"$scratch/recording-$run.json" 2>"$scratch/recording-$run.stderr"; then
    echo "dc1-compute-draw: recording consumer failed" >&2
    cat "$scratch/recording-$run.stderr" >&2
    exit 1
  fi
  if [[ -s "$scratch/clean-$run.stderr" || -s "$scratch/audit-$run.stderr" || -s "$scratch/recording-$run.stderr" ]]; then
    echo "dc1-compute-draw: a connected consumer wrote stderr" >&2
    cat "$scratch/clean-$run.stderr" "$scratch/audit-$run.stderr" "$scratch/recording-$run.stderr" >&2
    exit 1
  fi
done
diff -q "$scratch/clean-first.json" "$scratch/clean-second.json" >/dev/null
diff -q "$scratch/audit-first.json" "$scratch/audit-second.json" >/dev/null
diff -q "$scratch/recording-first.json" "$scratch/recording-second.json" >/dev/null

jq -e '
  ([keys[]] | sort) == (["controls","gate","onErrorCount","schemaVersion","status"] | sort)
  and .schemaVersion == 1
  and .gate == "dc1-compute-draw-consumer"
  and .status == "passed"
  and .controls == {blue:[0,0,255,255],green:[0,255,0,255],red:[255,0,0,255]}
  and .onErrorCount == 0
' "$scratch/clean-first.json" >/dev/null
jq -e '
  ([keys[]] | sort) == (["commitTrace","consumerByteOffset","cpuPacketReads","directVertexCount","gate","physicalByteOffset","sameAllocationGeneration","schemaVersion","status","viewRange"] | sort)
  and .schemaVersion == 1
  and .gate == "dc1-compute-draw-metal-audit"
  and .status == "passed"
  and .commitTrace == ["computeCommit","frameCommit"]
  and .viewRange == [16,32]
  and .consumerByteOffset == 0
  and .physicalByteOffset == 16
  and .directVertexCount == 0
  and .sameAllocationGeneration == true
  and .cpuPacketReads == 0
' "$scratch/audit-first.json" >/dev/null
jq -e '
  .schemaVersion == 1
  and .gate == "dc1-compute-draw-recording"
  and .status == "passed"
  and .renderedArguments == [3,1,0,0]
  and .commitTrace == ["computeCommit","frameCommit"]
  and .noCPUReadOrWait == true
  and .synchronousFailures.missingIndirectUsage == {code:"VGPU-INDIRECT-INVALID",submissionDelta:0,tokenDelta:0,onErrorDelta:0}
  and .synchronousFailures.foreignContext == {code:"VGPU-NATIVE-CONTEXT-MISMATCH",submissionDelta:0,tokenDelta:0,onErrorDelta:0}
  and .synchronousFailures.misalignedOffset == {code:"VGPU-INDIRECT-INVALID",submissionDelta:0,tokenDelta:0,onErrorDelta:0}
  and .synchronousFailures.shortRange == {code:"VGPU-INDIRECT-INVALID",submissionDelta:0,tokenDelta:0,onErrorDelta:0}
' "$scratch/recording-first.json" >/dev/null

expect_consumer_failure() {
  local label=$1
  if "$clean_binary" >"$scratch/$label.stdout" 2>"$scratch/$label.stderr"; then
    echo "dc1-compute-draw: $label unexpectedly succeeded" >&2
    return 1
  fi
  if [[ -s "$scratch/$label.stdout" || ! -s "$scratch/$label.stderr" ]]; then
    echo "dc1-compute-draw: $label did not fail closed" >&2
    return 1
  fi
}

expect_consumer_success() {
  local label=$1
  "$clean_binary" >"$scratch/$label.stdout" 2>"$scratch/$label.stderr"
  if [[ -s "$scratch/$label.stderr" ]]; then
    echo "dc1-compute-draw: $label wrote stderr" >&2
    cat "$scratch/$label.stderr" >&2
    return 1
  fi
  diff -q "$scratch/clean-first.json" "$scratch/$label.stdout" >/dev/null
}

clean_bin_directory="${clean_binary%/CleanConsumer}"
built_library="$(find "$clean_bin_directory" -type f -name 'AppShaders.metallib' -print)"
built_artifact="$(find "$clean_bin_directory" -type f -name 'AppShaders.artifact.json' -print)"
if [[ -z "$built_library" || "$built_library" == *$'\n'* || -z "$built_artifact" || "$built_artifact" == *$'\n'* ]]; then
  echo "dc1-compute-draw: expected one built copy of each AppShaders resource" >&2
  exit 1
fi
cp "$built_library" "$scratch/built-library.original"
printf '\0' >>"$built_library"
expect_consumer_failure tampered-library
cp "$scratch/built-library.original" "$built_library"
cp "$built_artifact" "$scratch/built-artifact.original"
printf ' ' >>"$built_artifact"
expect_consumer_failure descriptor-payload-cross
cp "$scratch/built-artifact.original" "$built_artifact"

cp "$artifact" "$scratch/artifact.original"
cp "$generated" "$scratch/generated.original"
for mutation in abi artifact-id entry-point fixed-layout fractional-integer program-order unicode-digest unknown; do
  cp "$scratch/$mutation-artifact.json" "$artifact"
  cp "$scratch/$mutation-generated.swift" "$generated"
  build_package "$assembly/CleanConsumer" "$scratch/build-clean" "build-mutation-$mutation"
  expect_consumer_failure "rehashed-$mutation"
done
cp "$scratch/model-artifact.json" "$artifact"
cp "$scratch/model-generated.swift" "$generated"
build_package "$assembly/CleanConsumer" "$scratch/build-clean" build-mutation-model
expect_consumer_success rehashed-irrelevant-model
cp "$scratch/artifact.original" "$artifact"
cp "$scratch/generated.original" "$generated"

if [[ -s "$poison_log" ]]; then
  echo "dc1-compute-draw: consumer build or execution invoked a forbidden tool" >&2
  cat "$poison_log" >&2
  exit 1
fi

jq -cn \
  --slurpfile clean "$scratch/clean-first.json" \
  --slurpfile audit "$scratch/audit-first.json" \
  --slurpfile recording "$scratch/recording-first.json" \
  '{
    schemaVersion: 1,
    gate: "dc1-compute-draw",
    status: "passed",
    controls: $clean[0].controls,
    expectedPacket: $recording[0].renderedArguments,
    commitTrace: $audit[0].commitTrace,
    viewRange: $audit[0].viewRange,
    consumerByteOffset: $audit[0].consumerByteOffset,
    physicalByteOffset: $audit[0].physicalByteOffset,
    directVertexCount: $audit[0].directVertexCount,
    sameAllocationGeneration: $audit[0].sameAllocationGeneration,
    cpuPacketReads: $audit[0].cpuPacketReads,
    intermediateCPUWaits: (
      if $recording[0].noCPUReadOrWait == true then 0
      else error("recording gate observed an intermediate CPU wait") end
    ),
    onErrorCount: $clean[0].onErrorCount,
    negativeCases: [
      {
        name: "missingIndirectUsage",
        code: $recording[0].synchronousFailures.missingIndirectUsage.code,
        acceptedSubmissions: $recording[0].synchronousFailures.missingIndirectUsage.submissionDelta,
        submissionTokens: $recording[0].synchronousFailures.missingIndirectUsage.tokenDelta,
        onErrorCount: $recording[0].synchronousFailures.missingIndirectUsage.onErrorDelta
      },
      {
        name: "foreignContext",
        code: $recording[0].synchronousFailures.foreignContext.code,
        acceptedSubmissions: $recording[0].synchronousFailures.foreignContext.submissionDelta,
        submissionTokens: $recording[0].synchronousFailures.foreignContext.tokenDelta,
        onErrorCount: $recording[0].synchronousFailures.foreignContext.onErrorDelta
      },
      {
        name: "misalignedOffset",
        code: $recording[0].synchronousFailures.misalignedOffset.code,
        acceptedSubmissions: $recording[0].synchronousFailures.misalignedOffset.submissionDelta,
        submissionTokens: $recording[0].synchronousFailures.misalignedOffset.tokenDelta,
        onErrorCount: $recording[0].synchronousFailures.misalignedOffset.onErrorDelta
      },
      {
        name: "shortRange",
        code: $recording[0].synchronousFailures.shortRange.code,
        acceptedSubmissions: $recording[0].synchronousFailures.shortRange.submissionDelta,
        submissionTokens: $recording[0].synchronousFailures.shortRange.tokenDelta,
        onErrorCount: $recording[0].synchronousFailures.shortRange.onErrorDelta
      }
    ]
  }'
