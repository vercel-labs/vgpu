# Generated compute vertical slice

This isolated Swift package tests one generated, backend-neutral compute program through the
proposed typed API:

```swift
let compute = try gpu.compute(
  InspectValues.self,
  bindings: .init(values: shortView, output: firstOutput)
)
let first = try compute.dispatch(x: 1)
try compute.set(\.values, to: longView)
try compute.set(\.output, to: secondOutput)
let second = try compute.dispatch(x: 1)
await first.settled()
await second.settled()
```

`GeneratedFixture` depends exactly on `VGPUABI`. Its binding witness supplies typed values at
semantic ordinals; it has no knowledge of Metal indices, transport models, or artifact URLs.
Core, Resources, and Compute use separate backend capabilities and targets. The corresponding
Metal implementations are also split, while `VGPUTesting` alone resolves test artifact URLs and
composes the physical capabilities.

The portable recording gate proves that `set` is atomic, dispatch snapshots are independent,
submission is synchronous through encode/commit, `gpu.settled()` cannot miss accepted work,
synchronous submit failure rolls back its ticket, deferred failure reaches `onError` before
settlement, an unobserved failure emits one diagnostic without creating a backlog, and a disposed
generation remains retained until all accepted submissions complete. The snapshot barrier makes
the `gpu.settled()` assertion deterministic rather than relying on task scheduling.

When passed the real `metallib` and semantic manifest from C1, the Metal gate runs two dispatches
against the same capacity-four allocation. Binding-visible ranges 28 and 52 produce readbacks
`[2, 202]` and `[4, 404]`, respectively. The ranges are byte lengths, not shader results: the fixed
prefix is 4 bytes and each trailing element has stride 12, so `4 + 2 * 12 = 28` and
`4 + 4 * 12 = 52`. The shader returns the visible `arrayLength()` and final visible ID. The gate
also verifies the physical immediate-data uploads and Metal reflection.

Run portable gates with:

```sh
./run.sh
```

Run the connected Metal gate with:

```sh
./run.sh /path/to/library.metallib /path/to/manifest.json
```

The canonical connected gate lets C1 create and authenticate those two scratch files, then launches
the probe twice and compares its output byte-for-byte:

```sh
node ../c1-semantic-bridge/gates/semantic-assembly.mjs \
  --worker /path/to/vgpu-tint-worker \
  --generated-compute-probe .build/arm64-apple-macosx/release/MetalProbe
```

This is evidence for one generated compute entry point, not production packaging and not the C4
two-entry-point, aliasing, ping-pong, or WebGPU-oracle gate. The underscored logical artifact
descriptor and package-only test catalog intentionally do not freeze a public artifact resolver.
It validates the compute submission integration with the separately tested L1 lifecycle contract;
it does not repeat L1's complete observer and waiter matrix. Its shared-memory read is used only
after both submissions settle and does not validate production readback queue ordering.
