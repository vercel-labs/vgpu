# Compute storage contract and C4 evidence

Status: the isolated C4 design gate passes on the available Apple-silicon machine. It validates the
proposed API and connected artifact boundary; it is not a production Swift package or a broader
hardware-support claim.

## Contract

One authored WGSL module may select several entry points. Code generation emits one nominal Swift
program type per selected entry, while all of those types may share one authenticated descriptor
and `.metallib`. A generated type fixes its `programID`, authored `entryPointID`, logical bindings,
access modes, and resolved workgroup size. Applications do not select an entry by passing a string
at runtime.

A root WGSL `array<T>` is represented by `VGPUStorage<T>`. Iterative compute can create two such
resources together:

```swift
let state = try gpu.pingPongStorage(
  UInt32.self,
  count: initial.count,
  initialValues: initial
)
```

`initialValues` initializes only `state.read`; the distinct `state.write` allocation is zeroed.
`state.swap()` synchronously exchanges those roles. It does not copy data, wait for completion, or
change a program instance's bindings. An accepted dispatch has already snapshotted its concrete
resource generations, so the application explicitly updates or constructs bindings for the next
step.

Individual `set` calls validate type, access, context, and range, but do not reject aliases across
the complete binding set. This permits the transient alias that necessarily appears between two
updates while reversing a source/destination pair. `dispatch` validates the final snapshot after
all updates and before work registration or backend submission.

The alias identity is `(allocationIdentity, generation)`, independent of wrapper, binding view, or
visible range. Repeating a generation in read-only bindings is valid. If any repeated occurrence is
writable, dispatch throws synchronously with `VGPU-R1-STORAGE-ALIASING`. The rule deliberately
rejects even disjoint views of one generation, keeping behavior independent of backend access
ordering. This synchronous preflight does not publish through `onError`.

One-shot dispatch commits its command buffer before returning a `VGPUSubmission`. A later dispatch
on the same Metal queue observes the first without a CPU wait. `gpu.settled()` snapshots all work
already accepted by the context and waits without throwing; deferred failures remain observable
through `onError`.

## Shared oracle fixture

[`compute-storage.wgsl`](../../../../experiments/native-metal-spikes/c4-compute-storage/fixtures/compute-storage.wgsl)
declares five runtime-sized `array<u32>` bindings. Both selected programs use `src`, `mask`, and
`dst`; `advance` uses `advanceAudit`, while `mix` uses `mixAudit`.

Both `src` and `mask` receive the same current read half. This proves read/read aliasing while the
writable destination remains on the other half.

| Program        | Semantic bindings              | Local Swift ordinals | Workgroup | Dispatch  | Audit            |
| -------------- | ------------------------------ | -------------------- | --------- | --------- | ---------------- |
| `AdvanceState` | `g0b0`, `g0b1`, `g0b2`, `g0b3` | `0`, `1`, `2`, `3`   | `(2,1,1)` | `(2,1,2)` | `[101, 2, 1, 2]` |
| `MixState`     | `g0b0`, `g0b1`, `g0b2`, `g0b4` | `0`, `1`, `2`, `3`   | `(1,2,1)` | `(2,2,1)` | `[202, 2, 2, 1]` |

The fourth binding of `MixState` retains semantic identity `g0b4`, but becomes ordinal `3` inside
that generated program. Ordinals are program-local ABI positions, not serialized WGSL binding
numbers.

Starting from `[0, 1, 2, 3, 4, 5, 6, 7]`, the sequence is:

1. Dispatch `AdvanceState` from A to B.
2. Swap roles.
3. Dispatch `MixState` from B to A without awaiting the first dispatch.
4. Swap roles and settle accepted work.

The exact final state is `[6, 14, 22, 30, 38, 46, 54, 62]`. A final negative dispatch binds the
current read generation as `src`, `mask`, and writable `dst`; it must fail synchronously, leave the
state and audit sentinel unchanged, and produce no `onError` delivery.

## Two independent paths

The TypeScript oracle reads the canonical fixture and uses only the public `vgpu/node` surface:
`init`, `compute`, `pingPongStorage`, resource read/write, `onError`, and `settled`. On macOS the
repository's Dawn WebGPU package executes through Metal. It runs twice, requires empty stderr, and
compares byte-identical output with the checked-in expectation.

The native path resolves the same WGSL once, inventories it twice, and performs two deterministic
semantic extractions and two deterministic Tint translations for each program. It combines the two
semantic programs, retains two independent Metal projections and runtime manifests, compiles both
AIR files, and links one `.metallib`.

The source-free C1 handoff is assembled into a relocatable SwiftPM package:

- generated `AppShaders` depends only on `VGPUABI`;
- `AdvanceState` and `MixState` share one private resource witness;
- `CleanConsumer` selects only `AppShaders` and backend-complete `VGPUMetalCompute`;
- no WGSL, MSL, AIR, Node.js, Tint executable, source path, or public `Bundle`/URL loader crosses
  into the consumer surface;
- the backend selects by `programID` plus `entryPointID`, validates exact manifest models and Metal
  reflection, and derives every buffer slot and runtime-size word from that selected manifest.

The connected probe runs two deterministic assemblers and two deterministic consumer processes. It
also relocates the package before resolution, builds with Swift 6 complete concurrency checks and
warnings as errors, and poisons Node, Tint, and offline Metal tools during package build and runtime.

Fail-closed canaries cover changed library bytes, crossed descriptor bytes, a rehashed incompatible
ABI, an unknown storage-size model, an unknown root member, a non-empty sampling-pair set, and
reordered program records.

## Recorded result

Run the aggregate gate from the repository root:

```sh
bash experiments/native-metal-spikes/c4-compute-storage/run.sh
```

The aggregate runner always executes the WebGPU oracle and the connected C1-to-Metal probe. The
accepted run reported:

| Evidence                  | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| C1 source-free handoff    | `31ad0fce7bc94901987ab697bfeff0eed35d8325fff55b942571e8a5d4b950ae` |
| Linked Metal library      | `a7639720f5f18f03d32bff47d114d23236c77c54537033db2ddf95cfff98a818` |
| Combined semantic model   | `28061895495ede38d9bd0932505b572b4ba2052e7961c0f028e8121c6f9d9785` |
| `AdvanceState` projection | `44518d855bb8774355e8074897a6737b5e526882196f55c485f7580f66be3ddb` |
| `MixState` projection     | `0f58b6230a57acd0ff79fbe765950e9baf9d16eed7c75f439c5b1b44ef6a09c4` |

Both paths returned the exact final state and audits above. Both rejected writable aliasing with
`VGPU-R1-STORAGE-ALIASING`, synchronously and without changing GPU-visible bytes or delivering an
asynchronous error.

## What remains open

This fixture validates simple root storage arrays and two compute entries. It does not establish a
production artifact format, final package naming, indirect dispatch or draw, storage textures,
general compute-to-render integration, or the complete compiler/runtime compatibility matrix.

Native execution currently covers the available Apple-silicon device. The same generated package
and runtime cross-compile for `x86_64`, but no physical Intel Mac is available; that is portability
evidence only, not Intel integrated or AMD discrete GPU execution evidence. The first supported
release must carry this contract into the production runtime and repeat it across its declared
toolchain and hardware matrix.
