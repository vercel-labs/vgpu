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

Run the WebGPU oracle, portable Swift recording layer, and C2 regression gates with:

```sh
./experiments/native-metal-spikes/dc1-compute-draw/run.sh
```

The separate compiler bridge resolves both semantic programs once, authenticates and translates
three stages, and links them into one source-free `metallib`. It deliberately reports whether the
connected probe was supplied, so a compiler-only pass cannot be mistaken for the complete DC1
gate.

## Pending Metal connected gate

The end-to-end Metal gate is **not implemented and no Metal result is claimed yet**. A later layer
must package the authenticated programs and projections, expose the same allocation as a bounded
`buffer.slice(bytes: 16..<32)`, submit compute and render on the same Metal queue without a CPU wait,
and reproduce the blue/red/green controls through the public Swift API.
