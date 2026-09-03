#!/bin/zsh

set -euo pipefail

FIXTURE_DIR=${0:A:h}
REPO_ROOT=$(git -C "$FIXTURE_DIR" rev-parse --show-toplevel)
ARTIFACTS_DIR="$FIXTURE_DIR/.artifacts"
MODE=quick

usage() {
  print "Usage: ./run.sh [--quick|--full]"
  print "  --quick  Run the six contract canaries (default)."
  print "  --full   Resolve and run every repository WGSL source too."
}

if (( $# > 1 )); then
  usage >&2
  exit 64
fi
case ${1:-"--quick"} in
  --quick) MODE=quick ;;
  --full) MODE=full ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 64 ;;
esac

export C1_FIXTURE_DIR="$FIXTURE_DIR"
export C1_REPO_ROOT="$REPO_ROOT"
export C1_ARTIFACTS_DIR="$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR/logs" "$ARTIFACTS_DIR/bin"

for tool in git node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    print -u2 "Missing prerequisite: $tool"
    exit 2
  fi
done
if [[ $MODE == full ]] && ! command -v rg >/dev/null 2>&1; then
  print -u2 "Missing prerequisite for --full: rg (ripgrep)"
  exit 2
fi
if [[ ! -f "$REPO_ROOT/packages/wgsl/dist/runtime/reflect-source.js" || ! -f "$REPO_ROOT/packages/wgsl/dist/runtime/resolve-shader.js" ]]; then
  print -u2 "Missing packages/wgsl build output. Build @vgpu/wgsl first; this runner does not install or build repository packages."
  exit 2
fi

print "Preparing $MODE inputs..."
node "$FIXTURE_DIR/scripts/prepare.mjs" "--$MODE" >"$ARTIFACTS_DIR/logs/prepare.log" 2>&1

candidate_failure=0
candidate_skipped=0

CARGO_BIN=${C1_CARGO:-$(command -v cargo 2>/dev/null || true)}
if [[ -n $CARGO_BIN ]]; then
  export CARGO_TARGET_DIR="$ARTIFACTS_DIR/cargo-target"
  print "Building and running Naga 30.0.1..."
  if "$CARGO_BIN" build --locked --release --manifest-path "$FIXTURE_DIR/naga-harness/Cargo.toml" >"$ARTIFACTS_DIR/logs/cargo.log" 2>&1; then
    export C1_NAGA_HARNESS="$CARGO_TARGET_DIR/release/vgpu-c1-naga-harness"
    if ! node "$FIXTURE_DIR/scripts/run-naga.mjs" >"$ARTIFACTS_DIR/logs/naga.log" 2>&1; then
      candidate_failure=1
      node "$FIXTURE_DIR/scripts/write-status.mjs" naga failed "Naga behavior drifted; inspect .artifacts/logs/naga.log."
    fi
  else
    candidate_failure=1
    node "$FIXTURE_DIR/scripts/write-status.mjs" naga failed "The pinned Naga harness did not build; inspect .artifacts/logs/cargo.log."
  fi
else
  candidate_skipped=1
  node "$FIXTURE_DIR/scripts/write-status.mjs" naga skipped "cargo is not available; no installation was attempted."
fi

webgpu_version=$(node -p 'try { require("webgpu/package.json").version } catch { "" }' 2>/dev/null || true)
if [[ $(uname -s) == Darwin && $webgpu_version == 0.4.0 ]] && node -e 'import("webgpu")' >/dev/null 2>&1; then
  print "Running Tint embedded in Dawn against real Metal pipelines..."
  if ! node "$FIXTURE_DIR/scripts/run-tint.mjs" >"$ARTIFACTS_DIR/logs/tint.log" 2>&1; then
    candidate_failure=1
    node "$FIXTURE_DIR/scripts/write-status.mjs" tint failed "Tint/Dawn behavior drifted; inspect .artifacts/logs/tint.log."
  fi
else
  candidate_skipped=1
  node "$FIXTURE_DIR/scripts/write-status.mjs" tint skipped "A Darwin host with webgpu@0.4.0 is required; no installation was attempted."
fi

if [[ -f "$ARTIFACTS_DIR/naga/results.json" ]] && [[ $(uname -s) == Darwin ]] && xcrun --find swiftc >/dev/null 2>&1; then
  print "Compiling Naga MSL through MTLDevice.makeLibrary at MSL 2.4..."
  export C1_METAL_RUNTIME_COMPILER="$ARTIFACTS_DIR/bin/metal-runtime-compiler"
  if xcrun swiftc "$FIXTURE_DIR/metal-runtime-compiler/main.swift" -framework Metal -o "$C1_METAL_RUNTIME_COMPILER" >"$ARTIFACTS_DIR/logs/swiftc.log" 2>&1; then
    if ! node "$FIXTURE_DIR/scripts/run-metal-runtime.mjs" >"$ARTIFACTS_DIR/logs/runtime-metal.log" 2>&1; then
      candidate_failure=1
      node "$FIXTURE_DIR/scripts/write-status.mjs" runtime-metal failed "Runtime Metal compilation failed; inspect .artifacts/logs/runtime-metal.log."
    fi
  else
    node "$FIXTURE_DIR/scripts/write-status.mjs" runtime-metal failed "The Swift runtime compiler did not build; inspect .artifacts/logs/swiftc.log."
  fi
else
  node "$FIXTURE_DIR/scripts/write-status.mjs" runtime-metal skipped "Naga output, Darwin, and xcrun swiftc are required; no installation was attempted."
fi

metal_component=$(xcodebuild -showComponent MetalToolchain 2>&1 || true)
offline_available=0
if print -r -- "$metal_component" | grep -q '^Status: installed$' \
  && xcrun --find metal >/dev/null 2>&1 \
  && xcrun --find metallib >/dev/null 2>&1 \
  && [[ -f "$ARTIFACTS_DIR/naga/results.json" ]]; then
  offline_available=1
  print "Running offline metal + metallib validation..."
  if ! node "$FIXTURE_DIR/scripts/run-offline-metal.mjs" >"$ARTIFACTS_DIR/logs/offline-metal.log" 2>&1; then
    candidate_failure=1
    node "$FIXTURE_DIR/scripts/write-status.mjs" offline-metal failed "Offline Metal compilation failed; inspect .artifacts/logs/offline-metal.log."
  fi
else
  node "$FIXTURE_DIR/scripts/write-status.mjs" offline-metal skipped "Xcode MetalToolchain is not installed, or metal/metallib is unavailable; no installation was attempted."
fi

node "$FIXTURE_DIR/scripts/summarize.mjs" >"$ARTIFACTS_DIR/logs/summary.log" 2>&1
print "Normalized result: $ARTIFACTS_DIR/summary.json"

if (( candidate_failure )); then
  print -u2 "C1 reproduction failed. Inspect $ARTIFACTS_DIR/logs."
  exit 1
fi
if (( candidate_skipped )); then
  print -u2 "C1 reproduction is partial because a translator candidate was skipped."
  exit 2
fi
if [[ ${C1_REQUIRE_OFFLINE_METAL:-0} == 1 ]] && (( ! offline_available )); then
  print -u2 "Offline Metal validation was required but MetalToolchain is unavailable."
  exit 1
fi
print "Translator comparison reproduced. C1 remains open until the standalone and offline gates in README.md are satisfied."
