#!/bin/bash

set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: run.sh [vgpu-tint-worker]" >&2
  exit 64
fi

spike_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$spike_dir/../../.." && pwd)"
worker="${1:-$repo_root/experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-universal}"
c1_gate="$repo_root/experiments/native-metal-spikes/c1-semantic-bridge/gates/compute-storage.mjs"

if [[ ! -x "$worker" ]]; then
  echo "c4-compute-storage: Tint worker is missing or not executable: $worker" >&2
  echo "pass an explicit worker path or build the c1-tint-direct-build component first" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/vgpu-c4-suite.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

if ! bash "$spike_dir/oracle/run.sh" >"$scratch/oracle.json" 2>"$scratch/oracle.stderr"; then
  cat "$scratch/oracle.stderr" >&2
  exit 1
fi
if [[ -s "$scratch/oracle.stderr" ]]; then
  cat "$scratch/oracle.stderr" >&2
  exit 1
fi

if ! node "$c1_gate" \
  --worker "$worker" \
  --probe "$spike_dir/probe.sh" \
  >"$scratch/c1.json" 2>"$scratch/c1.stderr"; then
  cat "$scratch/c1.stderr" >&2
  exit 1
fi
if [[ -s "$scratch/c1.stderr" ]]; then
  cat "$scratch/c1.stderr" >&2
  exit 1
fi

jq -e '
  .contract == "vgpu-native-c4-webgpu-oracle/v1"
  and .status == "passed"
  and .readbacks.final == [6,14,22,30,38,46,54,62]
  and .aliasing.code == "VGPU-R1-STORAGE-ALIASING"
' "$scratch/oracle.json" >/dev/null
jq -e '
  .schemaVersion == 1
  and .gate == "c1-compute-storage"
  and .status == "passed"
  and .resolverCalls == 1
  and .semanticPrograms == 2
  and .projections == 2
  and .runtimeManifests == 2
  and .probe == {
    status: "passed",
    gate: "c4-compute-storage",
    deterministicProcesses: 2
  }
' "$scratch/c1.json" >/dev/null

jq -cn \
  --slurpfile oracle "$scratch/oracle.json" \
  --slurpfile native "$scratch/c1.json" \
  '{
    schemaVersion: 1,
    gate: "c4-compute-storage-suite",
    status: "passed",
    oracle: {
      contract: $oracle[0].contract,
      readbacks: $oracle[0].readbacks,
      aliasing: $oracle[0].aliasing
    },
    native: {
      gate: $native[0].gate,
      handoffSHA256: $native[0].handoffSha256,
      librarySHA256: $native[0].metallibSha256,
      programs: $native[0].programs,
      connectedProbe: $native[0].probe
    }
  }'
