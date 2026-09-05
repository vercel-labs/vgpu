#!/bin/bash

set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: run.sh [vgpu-tint-worker]" >&2
  exit 64
fi

spike_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$spike_dir/../../.." && pwd)"
worker="${1:-$repo_root/experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-universal}"
bridge="$spike_dir/scripts/compiler-bridge.mjs"

for command_name in node jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "dc1-compute-draw: required command is missing: $command_name" >&2
    exit 1
  fi
done
if [[ ! -x "$worker" ]]; then
  echo "dc1-compute-draw: Tint worker is missing or not executable: $worker" >&2
  echo "pass an explicit worker path or build the c1-tint-direct-build component first" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/vgpu-dc1-suite.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

if ! bash "$spike_dir/oracle/run.sh" >"$scratch/oracle.json" 2>"$scratch/oracle.stderr"; then
  cat "$scratch/oracle.stderr" >&2
  exit 1
fi
if [[ -s "$scratch/oracle.stderr" ]]; then
  cat "$scratch/oracle.stderr" >&2
  exit 1
fi

if ! node "$bridge" \
  --worker "$worker" \
  --probe "$spike_dir/probe.sh" \
  >"$scratch/native.json" 2>"$scratch/native.stderr"; then
  cat "$scratch/native.stderr" >&2
  exit 1
fi
if [[ -s "$scratch/native.stderr" ]]; then
  cat "$scratch/native.stderr" >&2
  exit 1
fi

jq -e '
  .contract == "vgpu-native-dc1-webgpu-oracle/v1"
  and .status == "passed"
  and .packet == {words:8,decoyByteRange:[0,16],realByteRange:[16,32]}
  and .scenarios.blue.color == [0,0,255,255]
  and .scenarios.red.color == [255,0,0,255]
  and .scenarios.green.color == [0,255,0,255]
  and .positive.callsBeforeFirstAwait == ["compute.dispatch(1)","frame.drawIndirect(offset:16)"]
  and .positive.firstAwait == "target.read()"
  and .positive.packetReadbacks == 0
  and .positive.onErrorCount == 0
' "$scratch/oracle.json" >/dev/null
jq -e '
  .schemaVersion == 1
  and .gate == "dc1-compiler-bridge"
  and .status == "passed"
  and .connectedGate == true
  and .resolverCalls == 1
  and .semanticPrograms == 2
  and .projections == 2
  and .runtimeManifests == 2
  and .uniqueTranslations == 3
  and ([.programs[].semanticProgram] == ["ConsumePacket","ProducePacket"])
  and ([.programs[].kind] == ["draw","compute"])
  and .programs[0].bindings == []
  and .programs[1].bindings == ["g0b0"]
  and .programs[1].slots == [{stage:"compute",index:0}]
  and .probe.status == "passed"
  and .probe.gate == "dc1-compute-draw"
  and .probe.deterministicProcesses == 2
  and (.probe.reportSha256 | test("^[a-f0-9]{64}$"))
' "$scratch/native.json" >/dev/null

jq -cn \
  --slurpfile oracle "$scratch/oracle.json" \
  --slurpfile native "$scratch/native.json" \
  '{
    schemaVersion: 1,
    gate: "dc1-compute-draw-suite",
    status: "passed",
    oracle: {
      contract: $oracle[0].contract,
      packet: $oracle[0].packet,
      scenarios: $oracle[0].scenarios,
      positive: $oracle[0].positive
    },
    native: {
      gate: $native[0].gate,
      handoffSHA256: $native[0].handoffSha256,
      librarySHA256: $native[0].metallibSha256,
      programs: $native[0].programs,
      connectedProbe: $native[0].probe
    }
  }'
