#!/bin/bash

set -euo pipefail

on_error() {
  local status=$?
  echo "c4-compute-storage: probe failed at line ${BASH_LINENO[0]}" >&2
  exit "$status"
}
trap on_error ERR

expect_consumer_failure() {
  local label=$1
  local stdout_path="$scratch/$label.stdout"
  local stderr_path="$scratch/$label.stderr"
  local status
  if "$binary_path" >"$stdout_path" 2>"$stderr_path"; then
    echo "c4-compute-storage: $label unexpectedly succeeded" >&2
    return 1
  else
    status=$?
  fi
  if [[ $status -eq 0 || -s "$stdout_path" || ! -s "$stderr_path" ]]; then
    echo "c4-compute-storage: $label did not fail closed" >&2
    return 1
  fi
}

if [[ $# -ne 2 ]]; then
  echo "usage: probe.sh <library.metallib> <c1-handoff.json>" >&2
  exit 64
fi

spike_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$spike_dir/../../.." && pwd)"
runtime_source="$repo_root/experiments/native-metal-spikes/c2-generated-compute"
oracle_expected="$spike_dir/oracle/expected.json"
library=$1
handoff=$2

for command_name in node swift jq diff shasum find; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "c4-compute-storage: required command is missing: $command_name" >&2
    exit 1
  fi
done
if [[ ! -f "$runtime_source/Package.swift" || ! -d "$runtime_source/Sources" ]]; then
  echo "c4-compute-storage: C2 runtime prototype is missing" >&2
  exit 1
fi
if [[ ! -f "$oracle_expected" ]]; then
  echo "c4-compute-storage: WebGPU oracle expectation is missing" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/vgpu-c4-compute-storage.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

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
diff -qr "$scratch/assembly-a/CleanConsumer" "$scratch/assembly-b/CleanConsumer" >/dev/null

cp -R "$scratch/assembly-a" "$scratch/relocated"
diff -qr "$scratch/assembly-a" "$scratch/relocated" >/dev/null
assembly="$scratch/relocated"
mkdir "$assembly/RuntimePrototype"
cp "$runtime_source/Package.swift" "$assembly/RuntimePrototype/Package.swift"
cp -R "$runtime_source/Sources" "$assembly/RuntimePrototype/Sources"

app_package="$scratch/app-package.json"
consumer_package="$scratch/consumer-package.json"
swift package --package-path "$assembly/AppShaders" dump-package \
  >"$app_package" 2>"$scratch/app-package.stderr"
swift package --package-path "$assembly/CleanConsumer" dump-package \
  >"$consumer_package" 2>"$scratch/consumer-package.stderr"
if [[ -s "$scratch/app-package.stderr" || -s "$scratch/consumer-package.stderr" ]]; then
  echo "c4-compute-storage: SwiftPM package inspection wrote stderr" >&2
  exit 1
fi

jq -e '
  .products == [{"name":"AppShaders","settings":[],"targets":["AppShaders"],"type":{"library":["automatic"]}}]
  and ([.targets[] | select(.name == "AppShaders") | .dependencies[].product[0]] == ["VGPUABI"])
  and ([.targets[] | select(.name == "AppShaders") | .resources[].rule | has("process")] == [true])
  and ([.targets[] | select(.name == "AppShaders") | .resources[].path] == ["Resources"])
' "$app_package" >/dev/null
jq -e '
  ([.targets[] | select(.name == "CleanConsumer") | .dependencies[] |
    if has("product") then .product[0] else empty end] | sort)
  == (["AppShaders", "VGPUMetalCompute"] | sort)
' "$consumer_package" >/dev/null

generated="$assembly/AppShaders/Sources/AppShaders/AppShaders.generated.swift"
consumer="$assembly/CleanConsumer/Sources/CleanConsumer/main.swift"
artifact="$assembly/AppShaders/Sources/AppShaders/Resources/AppShaders.artifact.json"
bundled_library="$assembly/AppShaders/Sources/AppShaders/Resources/AppShaders.metallib"

if grep -Eq '^import (Metal|VGPUCore|VGPUResources|VGPUCompute|VGPUMetal|VGPUMetalCompute|VGPUTesting)$' "$generated"; then
  echo "c4-compute-storage: AppShaders imports a runtime or backend product" >&2
  exit 1
fi
if grep -Eq '^import (VGPUABI|VGPUMetalCompute|VGPUTesting|_VGPU)' "$consumer"; then
  echo "c4-compute-storage: clean consumer crosses an internal/testing boundary" >&2
  exit 1
fi
if ! grep -q '^private enum AppShadersResources' "$generated" || grep -Eq '^public .*\b(Bundle|URL)\b' "$generated"; then
  echo "c4-compute-storage: generated resource resolver is not private" >&2
  exit 1
fi
if [[ "$(grep -c '^private enum ArtifactWitness' "$generated")" -ne 1 ]]; then
  echo "c4-compute-storage: generated programs do not share one private artifact witness" >&2
  exit 1
fi
if grep -R -E --include='*.swift' --include='Package.swift' '\b(VGPUTesting|Tint|WGSL|MSL|AIR|Node|pnpm|npx)\b' "$assembly/AppShaders" "$assembly/CleanConsumer" >/dev/null; then
  echo "c4-compute-storage: generated/consumer source leaked a testing or toolchain dependency" >&2
  exit 1
fi
forbidden_generated_path="$(find "$assembly/AppShaders" "$assembly/CleanConsumer" \
  \( -type d -name node_modules -o -type f \( \
    -iname '*.wgsl' -o -iname '*.metal' -o -iname '*.msl' -o \
    -iname '*.air' -o -iname '*.js' -o -iname '*.mjs' -o -iname '*.cjs' \
  \) \) -print -quit)"
if [[ -n "$forbidden_generated_path" ]]; then
  echo "c4-compute-storage: generated package contains a source/compiler artifact" >&2
  exit 1
fi

descriptor_sha256="$(shasum -a 256 "$artifact" | awk '{print $1}')"
library_sha256="$(shasum -a 256 "$bundled_library" | awk '{print $1}')"
if [[ "$(tail -c 1 "$artifact" | od -An -t x1 | tr -d '[:space:]')" != "0a" ]]; then
  echo "c4-compute-storage: artifact descriptor has no final newline" >&2
  exit 1
fi
cmp -s "$library" "$bundled_library"
jq -e --arg library "$library_sha256" '
  .schemaVersion == 1
  and .contractId == "vgpu-native-c4-compute-storage-artifact/v1"
  and .artifactID == "c4-compute-storage"
  and .abi == {
    semanticSchemaVersion: 1,
    metalProjectionABI: 1,
    generatedSwiftABI: 1,
    bindingLayoutABI: 1,
    requiredVGPUABIVersion: 1
  }
  and .library.sha256 == $library
  and .evidence.metallibSha256 == $library
  and ([keys[]] | sort) == (["schemaVersion", "contractId", "artifactID", "abi", "semantic", "library", "programs", "evidence"] | sort)
  and ([.programs[] | .programID] == ["AdvanceState", "MixState"])
  and ([.programs[] | .entryPointID] == ["advance", "mix"])
  and ([.programs[] | .runtimeManifest.semanticProgram] == ["AdvanceState", "MixState"])
  and ([.programs[] | .runtimeManifest.entryPoints[0].metal] == ["vgpu_c4_advance", "vgpu_c4_mix"])
  and ([.programs[] | .runtimeManifest.resolvedWorkgroupSize] == [{x:2,y:1,z:1},{x:1,y:2,z:1}])
  and ([.programs[0].runtimeManifest.bindings[].semanticBinding] == ["g0b0", "g0b1", "g0b2", "g0b3"])
  and ([.programs[1].runtimeManifest.bindings[].semanticBinding] == ["g0b0", "g0b1", "g0b2", "g0b4"])
  and ([.programs[].runtimeManifest.bindings | map(.slots[0].index)] == [[0,1,2,3],[0,1,2,3]])
  and ([.programs[].runtimeManifest.bindings | map(.descriptor.access)] == [["read","read","read_write","read_write"],["read","read","read_write","read_write"]])
  and ([.programs[].runtimeManifest.bindings | map(.descriptor.runtimeSized)] == [[true,true,true,true],[true,true,true,true]])
' "$artifact" >/dev/null
jq -e --arg descriptor "$descriptor_sha256" --arg library "$library_sha256" '
  .schemaVersion == 1
  and .artifactID == "c4-compute-storage"
  and .descriptorSHA256 == $descriptor
  and .librarySHA256 == $library
  and ([.programs[] | .programID] == ["AdvanceState", "MixState"])
' "$scratch/assembly-a.json" >/dev/null
grep -Fq "_vgpuDescriptorSHA256 = \"$descriptor_sha256\"" "$generated"
grep -Fq "_vgpuLibrarySHA256 = \"$library_sha256\"" "$generated"

for mutation in abi model unknown sampling program-order; do
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
for tool_name in node npx pnpm tint vgpu-tint-compiler metal metallib; do
  ln -s "$spike_dir/scripts/poison-tool.sh" "$poison/$tool_name"
done

export C4C_POISON_LOG="$poison_log"
export PATH="$poison:$PATH"
swift build \
  --package-path "$assembly/CleanConsumer" \
  --scratch-path "$scratch/build-native" \
  -c release \
  -Xswiftc -strict-concurrency=complete \
  -Xswiftc -warnings-as-errors \
  >"$scratch/build-native.stdout" 2>"$scratch/build-native.stderr"
if [[ -s "$scratch/build-native.stderr" ]]; then
  echo "c4-compute-storage: native Swift build wrote stderr" >&2
  cat "$scratch/build-native.stderr" >&2
  exit 1
fi

swift build \
  --package-path "$assembly/CleanConsumer" \
  --scratch-path "$scratch/build-x86_64" \
  --triple x86_64-apple-macosx \
  -c release \
  -Xswiftc -strict-concurrency=complete \
  -Xswiftc -warnings-as-errors \
  >"$scratch/build-x86_64.stdout" 2>"$scratch/build-x86_64.stderr"
if [[ -s "$scratch/build-x86_64.stderr" ]]; then
  echo "c4-compute-storage: x86_64 Swift build wrote stderr" >&2
  cat "$scratch/build-x86_64.stderr" >&2
  exit 1
fi

binary_path="$(swift build \
  --package-path "$assembly/CleanConsumer" \
  --scratch-path "$scratch/build-native" \
  -c release \
  --show-bin-path 2>"$scratch/bin-path.stderr")/CleanConsumer"
if [[ -s "$scratch/bin-path.stderr" ]]; then
  echo "c4-compute-storage: Swift binary-path query wrote stderr" >&2
  exit 1
fi
"$binary_path" >"$scratch/consumer-first.json" 2>"$scratch/consumer-first.stderr"
"$binary_path" >"$scratch/consumer-second.json" 2>"$scratch/consumer-second.stderr"
if [[ -s "$scratch/consumer-first.stderr" || -s "$scratch/consumer-second.stderr" ]]; then
  echo "c4-compute-storage: clean consumer wrote stderr" >&2
  cat "$scratch/consumer-first.stderr" "$scratch/consumer-second.stderr" >&2
  exit 1
fi
diff -q "$scratch/consumer-first.json" "$scratch/consumer-second.json" >/dev/null
jq -e --slurpfile oracle "$oracle_expected" '
  .schemaVersion == 1
  and .gate == "c4-compute-storage-consumer"
  and .status == "passed"
  and .sequence == $oracle[0].sequence
  and .readbacks == $oracle[0].readbacks
  and .aliasing == $oracle[0].aliasing
' "$scratch/consumer-first.json" >/dev/null

binary_directory="${binary_path%/CleanConsumer}"
built_library="$(find "$binary_directory" -type f -name 'AppShaders.metallib' -print)"
built_artifact="$(find "$binary_directory" -type f -name 'AppShaders.artifact.json' -print)"
if [[ -z "$built_library" || "$built_library" == *$'\n'* || -z "$built_artifact" || "$built_artifact" == *$'\n'* ]]; then
  echo "c4-compute-storage: expected exactly one built copy of each private resource" >&2
  exit 1
fi

cp "$built_library" "$scratch/built-library.original"
printf '\0' >>"$built_library"
expect_consumer_failure "tampered-library"
cp "$scratch/built-library.original" "$built_library"

cp "$built_artifact" "$scratch/built-artifact.original"
printf ' ' >>"$built_artifact"
expect_consumer_failure "descriptor-payload-cross"
cp "$scratch/built-artifact.original" "$built_artifact"

for mutation in abi model unknown sampling program-order; do
  cp "$scratch/$mutation-artifact.json" "$artifact"
  cp "$scratch/$mutation-generated.swift" "$generated"
  swift build \
    --package-path "$assembly/CleanConsumer" \
    --scratch-path "$scratch/build-native" \
    -c release \
    -Xswiftc -strict-concurrency=complete \
    -Xswiftc -warnings-as-errors \
    >"$scratch/build-$mutation.stdout" 2>"$scratch/build-$mutation.stderr"
  if [[ -s "$scratch/build-$mutation.stderr" ]]; then
    echo "c4-compute-storage: $mutation canary build wrote stderr" >&2
    cat "$scratch/build-$mutation.stderr" >&2
    exit 1
  fi
  expect_consumer_failure "rehashed-$mutation"
done

if [[ -s "$poison_log" ]]; then
  echo "c4-compute-storage: package build or consumer invoked a forbidden generator/compiler" >&2
  cat "$poison_log" >&2
  exit 1
fi

semantic_sha256="$(jq -r '.semanticSHA256' "$scratch/assembly-a.json")"
advance_projection_sha256="$(jq -r '.programs[0].projectionSHA256' "$scratch/assembly-a.json")"
mix_projection_sha256="$(jq -r '.programs[1].projectionSHA256' "$scratch/assembly-a.json")"
jq -cn \
  --arg descriptorSHA256 "$descriptor_sha256" \
  --arg librarySHA256 "$library_sha256" \
  --arg semanticSHA256 "$semantic_sha256" \
  --arg advanceProjectionSHA256 "$advance_projection_sha256" \
  --arg mixProjectionSHA256 "$mix_projection_sha256" \
  --slurpfile consumer "$scratch/consumer-first.json" \
  '{
    schemaVersion: 1,
    gate: "c4-compute-storage",
    status: "passed",
    artifactID: "c4-compute-storage",
    descriptorSHA256: $descriptorSHA256,
    librarySHA256: $librarySHA256,
    semanticSHA256: $semanticSHA256,
    programs: [
      {programID: "AdvanceState", projectionSHA256: $advanceProjectionSHA256},
      {programID: "MixState", projectionSHA256: $mixProjectionSHA256}
    ],
    deterministicAssemblies: 2,
    deterministicProcesses: 2,
    readbacks: $consumer[0].readbacks,
    aliasing: $consumer[0].aliasing
  }'
