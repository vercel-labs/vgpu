# UniformPool

`UniformPool` stages per-draw uniform bytes in CPU memory and uploads them to a
WebGPU uniform buffer at the frame boundary. Each `push()` returns the dynamic
offset, in bytes, to pass when binding the slot for a draw.

## Slots

`pool.alloc(layout)` returns a `UniformSlot<T>` with:

- `slot.gpu`: the underlying `GPUBuffer` used by the pool.
- `slot.bindGroup`: a real `GPUBindGroup` with a dynamic uniform-buffer binding.
- `slot.bindGroupLayout`: a real `GPUBindGroupLayout` whose binding uses
  `hasDynamicOffset: true`.
- `slot.stride`: `layout.size` padded up to the device's uniform-buffer offset
  alignment.

All slots allocated by one pool share the same backing `GPUBuffer`. Each slot
has its own bind group so callers can bind the slot once and vary only the
dynamic offset returned by `push()` or `pushBytes()`.

## Pipeline layout sharing

A layout may provide a pre-built bind group layout:

```ts
const slot = pool.alloc({
  size,
  bindGroupLayout: material.bindGroupLayout,
  encode(value, dst, byteOffset) {
    // write uniform bytes
  },
});
```

When `bindGroupLayout` is provided, the slot reuses it instead of creating a new
layout. Use this when a pipeline already owns the bind group layout that will
consume the slot's bind group.

## Frame uploads

`push(value)` and `pushBytes(bytes)` write into the pool's CPU mirror only. They
do not call WebGPU immediately. `endFrame()` uploads pending bytes with
`device.gpu.queue.writeBuffer(pool.gpu, 0, pool.cpuMirror, 0, pool.usedBytes)`.

Calling `endFrame()` on a clean pool is a no-op. If more values are pushed after
`endFrame()`, a later `endFrame()` uploads the updated CPU mirror again.

## Submit readiness

Call `endFrame()` before submitting command buffers that read data from the
pool. `assertReadyForSubmit(opName)` checks this invariant. If there are pending
pushes that have not been uploaded, it throws `VGPU-CORE-INVALID-USAGE` with:

```txt
UniformPool has unflushed pushes; call endFrame() before submitting.
```

Renderers should call `assertReadyForSubmit()` immediately before
`queue.submit()`.
