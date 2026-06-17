# StorageBuffer

`StorageBuffer` is one stable storage buffer for a single render (or compute)
pass, rewritten as needed and change-gated by the caller. It is the
storage-buffer counterpart to `Uniform`: it creates a `storage | copy_dst`
buffer, a bind group layout with a single storage binding at binding 0, and a
bind group wired to that buffer. `write()` uploads bytes with
`queue.writeBuffer` at a fixed offset — there is no dynamic offset and the bind
group never changes.

## When to use `StorageBuffer` vs `Uniform` vs `UniformPool`

Use `StorageBuffer` when the data is too large or too dynamic for a uniform:
arrays, runtime-sized data, particle/instance state, lookup tables. Storage
buffers can be much larger than uniforms — up to the adapter's
`maxStorageBufferBindingSize` (typically 128 MiB) versus a uniform's 64 KiB —
and the shader can write them with `access: "read-write"`.

Use `Uniform` for the common "globals/camera per pass" case: a small, fixed,
read-only buffer (`var<uniform>`).

Use `UniformPool` only when you have **many** small per-draw uniforms. It is a
dynamic-offset ring allocator: every slot binding is marked
`hasDynamicOffset: true` and the whole CPU mirror is re-uploaded each frame.

## `access`: read vs read-write

`access` controls both the bind group layout entry type and the default
visibility:

- `"read"` (default) → WGSL `var<storage, read>`, layout type
  `"read-only-storage"`, default visibility `VERTEX | FRAGMENT`.
- `"read-write"` → WGSL `var<storage, read_write>`, layout type `"storage"`,
  default visibility `FRAGMENT | COMPUTE`.

> WebGPU forbids writable storage buffers in the **vertex** stage. The
> `"read-write"` default visibility omits `VERTEX` for this reason — do not add
> it back, or pipeline creation will fail validation.

## Constructor

```ts
new StorageBuffer(device, {
  size,            // byte size of the storage buffer (required)
  label,           // optional debug label for buffer, layout, and bind group
  access,          // "read" (default) | "read-write"
  visibility,      // GPUShaderStageFlags; defaults by access (see above)
  bindGroupLayout, // optional pipeline-owned layout to reuse instead of creating one
});
```

- `size`: byte size of the storage buffer. May be far larger than a uniform.
- `label`: optional debug label; suffixed `.bgl` / `.bg` for the layout and bind
  group.
- `access`: `"read"` (default, read-only storage) or `"read-write"` (writable
  storage). Selects the layout entry type and the default visibility.
- `visibility`: shader stages that access binding 0. Defaults to
  `VERTEX | FRAGMENT` for `"read"` and `FRAGMENT | COMPUTE` for `"read-write"`.
  Ignored when `bindGroupLayout` is provided.
- `bindGroupLayout`: reuse a pipeline-owned bind group layout instead of creating
  one. Its binding 0 must be a storage buffer compatible with `size` and
  `access`.

## Members

- `storageBuffer.gpu`: the underlying storage `GPUBuffer`.
- `storageBuffer.buffer`: the VGPU `Buffer` wrapper around `gpu`.
- `storageBuffer.bindGroup`: the `GPUBindGroup` to bind for the pass.
- `storageBuffer.bindGroupLayout`: the `GPUBindGroupLayout` (created or reused).
- `storageBuffer.size`: the buffer byte size.
- `storageBuffer.access`: the resolved access mode (`"read"` or `"read-write"`).
- `storageBuffer.write(data, offset = 0)`: uploads `data` via
  `device.queue.writeBuffer(gpu, offset, data)`. No dynamic offset; the bind
  group is unchanged. Call only when the contents actually change.
- `storageBuffer.destroy()` / `storageBuffer.dispose()`: releases the backing
  buffer once; idempotent.

## Example

```ts
// A read-only array the fragment shader samples:
//   @group(0) @binding(0) var<storage, read> values: array<f32>;
const storage = new StorageBuffer(device, { size: 4 * count, label: "values" });
storage.write(new Float32Array(values));

const pipeline = createRenderPipelineFromDescriptor(device, {
  layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [storage.bindGroupLayout] }),
  vertex: { module, entryPoint: "vs_main" },
  fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
});

pass.setPipeline(pipeline);
pass.setBindGroup(0, storage.bindGroup);
pass.draw(3);

// A compute-written scratch buffer:
//   @group(0) @binding(0) var<storage, read_write> out: array<u32>;
const scratch = new StorageBuffer(device, { size: 4 * count, access: "read-write" });
```
