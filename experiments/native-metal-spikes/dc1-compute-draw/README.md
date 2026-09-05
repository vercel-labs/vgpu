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
order, not internal queue instrumentation; the pending native recording backend owns the exact
submission and wait trace.

Run the currently executable layer with:

```sh
./experiments/native-metal-spikes/dc1-compute-draw/run.sh
```

## Pending native connected gate

The connected SwiftPM/Metal gate is **not implemented and no native result is claimed yet**. A later
layer must compile authenticated semantic programs and Metal projections into one metallib, expose
the same allocation as a bounded `buffer.slice(bytes: 16..<32)`, submit compute and render on the
same queue without a CPU wait, and reproduce the blue/red/green controls through public Swift API.
