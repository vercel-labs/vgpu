# UniformPool

`UniformPool` is a frame-local CPU-side allocator for uniform data. It stores
encoded uniform bytes in one `ArrayBuffer` and returns dynamic offsets from
slot pushes, so render code can keep the same offset-oriented shape that WebGPU
uses for dynamic uniform buffers.

## Signature

`new UniformPool(device, opts?)`

Options:

- `capacityBytes`: total byte capacity for one frame. Defaults to 4 MiB.
- `minOffsetAlignment`: byte alignment for returned offsets. Defaults to the
  device limit when available, otherwise 256 bytes.
- `maxUniformBindingSize`: largest accepted layout size. Defaults to the device
  limit when available, otherwise 64 KiB.

## Layouts and slots

Call `pool.alloc(layout)` to create a `UniformSlot`. A layout provides a
host-shareable `size` and an `encode(value, dst, byteOffset)` function that
writes the value into the pool's `cpuMirror` `ArrayBuffer`.

A slot exposes:

- `stride`: the layout size rounded up to `minOffsetAlignment`.
- `push(value)`: encodes a value into the CPU mirror and returns the dynamic
  offset for that write.
- `pushBytes(bytes)`: copies already encoded bytes whose length equals the
  layout size.
- `gpu`: the backing `GPUBuffer` for low-level code that needs it.

`bindGroup` and `bindGroupLayout` are currently `null`; callers can still use
the returned offsets and CPU mirror behavior today.

## Frame lifecycle

Use one frame cycle at a time:

1. `beginFrame(frameIndex)` resets `usedBytes` to zero and allows pushes.
2. `slot.push(...)` writes into `cpuMirror` at the current offset.
3. `endFrame()` closes the frame's writes.

After `endFrame()`, pushing again before the next `beginFrame()` throws a
`VGPUError` with code `VGPU-CORE-UNIFORM-POOL-PUSH-AFTER-FLUSH`.

If a push would exceed `capacityBytes`, it throws `VGPU-UNIFORM-POOL-OVERFLOW`.
If a layout is too large for the pool or binding limit, `alloc()` throws
`VGPU-UNIFORM-LAYOUT-OVERSIZED`.

Call `dispose()` to destroy the backing GPU buffer. Repeated disposal is safe.
