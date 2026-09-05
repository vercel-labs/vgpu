# C4 compute and storage spike

C4 validates iterative storage compute against one shared WGSL fixture. The TypeScript side runs
through the public `vgpu/node` API on Dawn WebGPU. The native side resolves that same file once,
extracts two semantic programs, translates both with Tint, links one Metal library, packages two
generated Swift program types, and executes them through the public prototype runtime.

```text
                         compute-storage.wgsl
                         /                  \
                public vgpu/node       C1 semantic + Tint
                       |                       |
                WebGPU oracle          one source-free artifact
                                               |
                                      generated AppShaders
                                               |
                                      public Swift runtime
                                               |
                                             Metal
```

Run the complete suite from the repository root after building the direct Tint worker:

```sh
bash experiments/native-metal-spikes/c4-compute-storage/run.sh
```

Pass a worker explicitly when it is not at the default direct-build artifact path:

```sh
bash experiments/native-metal-spikes/c4-compute-storage/run.sh \
  /path/to/vgpu-tint-worker
```

Success is one deterministic `c4-compute-storage-suite` JSON object on stdout and no stderr. The
suite always runs both the WebGPU oracle and the connected C1-to-Metal gate. `probe.sh` is the
internal two-argument executable C1 invokes with its authenticated scratch metallib and handoff;
running it alone does not run the WebGPU oracle.

## Contract under test

The fixture declares five root `array<u32>` storage bindings. Both programs bind the same current
read half to `src` and `mask`, proving that read/read aliasing is valid. Their writable destination
is the other half.

- `AdvanceState` selects `advance`, uses local binding ordinals `0...3`, dispatches `(2, 1, 2)`,
  and writes audit `[101, 2, 1, 2]`.
- After `state.swap()`, `MixState` selects `mix`, independently uses local ordinals `0...3`,
  dispatches `(2, 2, 1)`, and writes audit `[202, 2, 2, 1]`. Its fourth semantic binding is
  `g0b4`; semantic identity does not become a sparse generated ABI ordinal.
- Starting from `[0, 1, 2, 3, 4, 5, 6, 7]`, both backends must produce
  `[6, 14, 22, 30, 38, 46, 54, 62]` without a CPU wait between dispatches.
- Binding the current read generation as both read-only source and writable destination must throw
  `VGPU-R1-STORAGE-ALIASING` synchronously. No command may be submitted, state and audit bytes must
  remain unchanged, and the rejection must not reach `onError`.

`VGPUPingPongStorage` owns two ordinary `VGPUStorage` allocations. `initialValues` seeds only the
initial read half; the write half starts at zero. `swap()` exchanges roles synchronously without
copying, waiting, or mutating program bindings. Each accepted dispatch has already snapshotted its
concrete resource generations.

## Artifact boundary

The C1 handoff contains one combined semantic module, two independent Metal projections and
runtime manifests, and digest-only evidence. The deterministic assembler validates that exact
source-free handoff and emits one artifact descriptor with ordered `AdvanceState` and `MixState`
records plus one shared metallib.

Generated `AppShaders` depends only on `VGPUABI`. A private shared witness loads owned descriptor
and library bytes and embeds both SHA-256 digests. `CleanConsumer` selects only `AppShaders` and the
backend-complete `VGPUMetalCompute` product, while explicitly importing the public modules it uses.
It receives no WGSL, MSL, AIR, compiler executable, filesystem path, or public resource resolver.

The backend authenticates the descriptor and library, validates the exact ABI and manifest models,
selects a program by both generated `programID` and authored `entryPointID`, checks Metal reflection,
derives every external buffer slot and runtime-size word from the selected manifest, and only then
creates a pipeline or submits work.

## Gates and limits

The connected probe requires deterministic assembly and process output, relocation before SwiftPM
resolution, Swift 6 complete concurrency checking, exact package dependency boundaries, exact
readback parity with the checked-in oracle expectation, and fail-closed canaries for tampered bytes,
unsupported ABI or size model, unknown descriptor data, sampling pairs, and reordered programs.
Poison executables prove package build and runtime do not invoke Node, Tint, or Metal compiler tools.

The native execution is evidence for the available Apple-silicon Metal device. The x86_64 gate is
compile-only because no physical Intel Mac is available; it is not an Intel or AMD runtime-support
claim. This remains an isolated API and packaging spike, not a shipped Swift package, production
artifact format, or broad shader-feature promise.
