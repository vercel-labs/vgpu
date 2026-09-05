# DC1 compute-to-draw

This directory defines DC1, a GPU-only compute-to-render dependency through a non-indexed indirect draw. The
canonical WGSL fixture contains a compute program and a render program over one eight-`u32`
allocation. Compute writes the real draw packet at bytes `16..<32`; render has no resource binding
and colors its two procedural triangles from `vertex_index`, making `firstVertex` observable.

The public WebGPU oracle uses three fresh scenarios:

- offset 0 consumes a zero-count decoy and leaves the target blue;
- offset 16 consumes the initial real packet and renders red;
- compute dispatch followed immediately by a frame drawing from offset 16 renders green.

In the positive scenario the application makes no packet readback, settlement, or other `await`
between the compute dispatch and render frame. The first await after those calls is the target
readback. The oracle runs twice and requires byte-identical output. Its report records public call
order, not internal queue instrumentation.

The portable Swift recording layer exercises the proposed API directly. It verifies two ordered
commits, one allocation and generation across compute and draw, relative nested buffer slices, no
storage read or wait between submissions, and synchronous fail-closed validation. Buffer usage is
carried through the allocation SPI so a future Vulkan backend can select its immutable indirect
usage at creation time. This layer records command consumption in a fake backend; it does not prove
Metal visibility or a native resource transition.

Run the complete WebGPU and connected Swift/Metal suite with:

```sh
bash experiments/native-metal-spikes/dc1-compute-draw/run.sh
```

Pass a Tint worker explicitly when it is not at the default direct-build artifact path:

```sh
bash experiments/native-metal-spikes/dc1-compute-draw/run.sh \
  /path/to/vgpu-tint-worker
```

Success is one deterministic `dc1-compute-draw-suite` JSON object on stdout and no stderr. The
suite always runs both the public WebGPU oracle and the connected compiler-to-Metal gate. The
compiler bridge resolves both semantic programs once, authenticates and translates three stages,
and links them into one source-free `metallib`. Its external probe runs twice and requires
byte-identical reports, so a compiler-only pass cannot be mistaken for the complete DC1 gate.

## Connected Metal gate

The isolated connected gate passes. Real WGSL crosses the semantic bridge, Tint, and Apple's Metal
compiler before a deterministic assembler emits one relocatable SwiftPM artifact. Generated
`AppShaders` depends only on `VGPUABI`; clean consumer code selects the separate
`VGPUMetalCompute` and `VGPUMetalRender` products without importing internal or testing modules.

Two connected processes reproduce exact blue, red, and green controls. The positive trace is
`computeCommit` followed by `frameCommit` on the shared Metal queue, using one allocation and
generation, view range `[16, 32]`, consumer offset `0`, physical offset `16`, and a direct vertex
count of `0`. There is no packet readback or application await between dispatch and frame; target
readback is the first suspension after both commits. The sequential fixture also requires one
authenticated Metal-library load. Portable recording proves nested relative slices and rejects
missing usage, a foreign context, misalignment, a short range, and offset overflow before
submission, token registration, or `onError`.

The current connected report SHA-256 is
`c9e5f8211a5db1d059d8919869a56678672d050438eb953b28673a10f1b8283c`; its metallib SHA-256 is
`f2cdafbd783e0673928e77bf2934b6a0a8844d4b653a4f5f13de3da9ebd927e6`, and its compiler handoff
SHA-256 is `7554797a66b9734710ce833c7c393818fde62bfbc1ee1a77899a0e7414a1758f`.

This remains an isolated overlay and fixture, not the distributable runtime or production artifact
format. Native execution covers the available Apple-silicon device. The `x86_64` consumer build is
compile-only evidence, not Intel or AMD GPU execution. Indexed draw, indirect dispatch,
runtime-sized or imported buffer views, and a Vulkan transition remain untested here.
