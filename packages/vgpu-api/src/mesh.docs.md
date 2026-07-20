# gpu.mesh

Creates an immutable vertex/index layout plus mutable GPU buffers for `gpu.draw()`. The v2 descriptor form accepts named attributes, multiple vertex streams, instancing streams, indices, topology, writes, and slices. Existing scene geometry descriptors such as `box()` continue to work as primitive sugar.

## Import

```ts
import type { Mesh, MeshOptions, MeshBufferOptions, MeshSliceOptions } from "vgpu";
import { box } from "vgpu/scene";
```

## Signature

```ts
interface Gpu {
  mesh(geometry: import("vgpu/scene").SceneGeometry): Mesh;
  mesh(options: MeshOptions): Mesh;
}

type MeshData = ArrayBuffer | ArrayBufferView;
type MeshAttributes = {
  readonly [name: string]: GPUVertexFormat | MeshAttributeOverride;
};

interface MeshAttributeOverride {
  readonly format: GPUVertexFormat;
  readonly offset?: number;
  readonly location?: number;
}

interface MeshBufferOptions {
  readonly attributes: MeshAttributes;
  readonly data?: MeshData;
  readonly buffer?: GPUBuffer;
  readonly stride?: number;
  readonly stepMode?: GPUVertexStepMode;
  readonly label?: string;
}

interface MeshOptions {
  readonly buffers: readonly MeshBufferOptions[];
  readonly vertexCount?: number;
  readonly instanceCount?: number;
  readonly indices?: Uint16Array | Uint32Array | readonly number[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly indexCount?: number;
  readonly topology?: GPUPrimitiveTopology;
  readonly label?: string;
}

interface MeshBuffer {
  readonly gpu: GPUBuffer;
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  write(data: MeshData, byteOffset?: number): void;
}

interface MeshSliceOptions {
  readonly firstIndex?: number;
  readonly indexCount?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
  readonly vertexCount?: number;
  readonly instanceCount?: number;
  readonly label?: string;
}

interface Mesh {
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly instanceCount?: number;
  readonly vertexBuffers?: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
  readonly topology: GPUPrimitiveTopology;
  readonly buffers: readonly MeshBuffer[];
  slice(opts?: MeshSliceOptions): MeshSlice;
  write(data: MeshData, byteOffset?: number): void;
  writeIndices(data: Uint16Array | Uint32Array, byteOffset?: number): void;
  destroy(): void;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---:|---|---|
| geometry | `SceneGeometry` | ✔ | — | v1 primitive sugar path. Emits pinned locations: `position` → `@location(0)`, `normal` → `@location(1)`, `uv` → `@location(2)`. |
| options.buffers | `readonly MeshBufferOptions[]` | ✔ | — | Vertex buffer streams. Maximum 8. |
| buffer.attributes | `MeshAttributes` | ✔ | — | Record form only. Key is the WGSL vertex input name unless `location` is specified. Maximum 16 attributes total. |
| attribute format | `GPUVertexFormat` | ✔ | — | Shorthand value: `{ position: "float32x3" }`. |
| attribute.offset | `number` | ✖ | tight-packed order | Byte offset within the stream. Integer-like attribute keys are rejected to avoid JavaScript key reordering. |
| attribute.location | `number` | ✖ | shader name match | Explicit shader location. When present, the record key is only a label. |
| buffer.data | `MeshData` | ✖ | — | Creates an owned `["vertex", "copy_dst"]` buffer and uploads the initial data. Mutually exclusive with `buffer`. |
| buffer.buffer | `GPUBuffer` | ✖ | — | Caller-owned escape hatch. Mutually exclusive with `data`; not destroyed by `mesh.destroy()`. |
| buffer.stride | `number` | ✖ | `roundUp4(sum(format sizes))` | Explicit stride for padded/interleaved data. Must be valid for WebGPU vertex buffers. |
| buffer.stepMode | `"vertex" \| "instance"` | ✖ | `"vertex"` | Instance streams derive `mesh.instanceCount` from the first instance buffer with data. |
| options.vertexCount | `number` | ✖ | derived | Derived from the first vertex-step buffer with data. |
| options.instanceCount | `number` | ✖ | derived | Draw default after `DrawCallOptions.instances` and `DrawOptions.instances`. |
| options.indices | `Uint16Array \| Uint32Array \| readonly number[]` | ✖ | — | Creates an owned `["index", "copy_dst"]` index buffer. `Uint16Array` infers `"uint16"`; otherwise `"uint32"`. |
| options.indexBuffer | `GPUBuffer` | ✖ | — | Caller-owned index buffer escape hatch. Pair with `indexFormat` and `indexCount`. |
| options.topology | `GPUPrimitiveTopology` | ✖ | `"triangle-list"` | Pipeline-affecting mesh topology. Strip topologies derive `stripIndexFormat` from `indexFormat`. |
| mesh.slice.opts | `MeshSliceOptions` | ✖ | full range | Frozen range view sharing buffers and layout identity with the parent mesh. |
| mesh.write.data | `MeshData` | ✔ | — | Writes to buffer 0 using `queue.writeBuffer`. No resize. |
| mesh.writeIndices.data | `Uint16Array \| Uint32Array` | ✔ | — | Writes to an index buffer owned from `options.indices`. Write caller-owned `indexBuffer` objects directly. No resize. |

**Returns:** `gpu.mesh()` returns `Mesh`; `mesh.slice()` returns `MeshSlice`; `write()`, `writeIndices()`, and `destroy()` return `void`.

## Error codes

| Code | When | Fix |
|---|---|---|
| `VGPU-MESH-LAYOUT-INVALID` | Invalid stride/offset/format, both `data` and `buffer`, or integer-like attribute key. | Use record keys that are names, align offsets/strides, and choose one data source. |
| `VGPU-MESH-LIMIT-EXCEEDED` | More than 8 buffers or 16 attributes. | Split draws or reduce streams/attributes. |
| `VGPU-MESH-LOCATION-CONFLICT` | Duplicate explicit `location` values. | Give each explicit shader location once. |
| `VGPU-MESH-DATA-MISALIGNED` | Data byte length is not divisible by stride, or index bytes do not match format. | Repack data or pass an explicit `stride`. |
| `VGPU-MESH-RANGE-INVALID` | Slice or draw-time range is negative, non-integer, outside parent counts, or uses index ranges on non-indexed meshes. | Clamp ranges and use indexed fields only with indexed meshes. |
| `VGPU-MESH-WRITE-RANGE` | `write()` or `writeIndices()` would overflow the fixed buffer. | Create a larger mesh; writes do not resize buffers. |
| `VGPU-MESH-ATTRIBUTE-UNMATCHED` | Named mesh attribute has no vertex-stage shader input. | Rename the attribute or specify `location`. |
| `VGPU-MESH-INPUT-MISSING` | Shader declares an uncovered `@location` input. | Add the mesh attribute or remove the shader input. |
| `VGPU-MESH-FORMAT-MISMATCH` | Vertex format base type does not match the WGSL input base type. | Use a compatible `GPUVertexFormat`; width differences are allowed by WebGPU. |

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const positions = new Float32Array([
  -1, -1, 0,
   1, -1, 0,
   0,  1, 0,
]);

const triangle = gpu.mesh({
  buffers: [{
    data: positions,
    attributes: { position: "float32x3" },
  }],
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const ledVertices = new Float32Array(6 * 6);
const ledMesh = gpu.mesh({
  label: "triangle-led-front-led-emitters",
  buffers: [{
    data: ledVertices,
    stride: 24,
    attributes: {
      position: "float32x2",
      local: "float32x2",
      led_index: "float32",
    },
  }],
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const quadCorners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const instanceData = new Float32Array(4 * 10);
const particles = gpu.mesh({
  topology: "triangle-strip",
  buffers: [
    { data: quadCorners, attributes: { corner: "float32x2" } },
    { stepMode: "instance", data: instanceData, attributes: {
      i_pos: "float32x3",
      i_color: { format: "unorm8x4", location: 5 },
    } },
  ],
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const vertexData = new Float32Array(3 * 4500);
const allIndices = new Uint32Array(4500);
const gltfMesh = gpu.mesh({
  buffers: [{ data: vertexData, attributes: { position: "float32x3" } }],
  indices: allIndices,
});
const hull = gltfMesh.slice({ firstIndex: 0, indexCount: 3600 });
const glass = gltfMesh.slice({ firstIndex: 3600, indexCount: 900, label: "glass" });
const pbrWgsl = "@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f { return vec4f(position, 1); }";

gpu.draw({ shader: pbrWgsl, mesh: hull });
gpu.draw({ shader: pbrWgsl, mesh: glass, blend: "alpha" });
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const glyphQuads = new Float32Array(4 * 4);
const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);
const text = gpu.mesh({
  buffers: [{ data: glyphQuads, attributes: { pos: "float32x2", uv: "float32x2" } }],
  indices: quadIndices,
});
const sdfTextWgsl = "@vertex fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> @builtin(position) vec4f { return vec4f(pos, 0, 1); }";
const textDraw = gpu.draw({ shader: sdfTextWgsl, mesh: text });
const target = gpu.target({ size: [640, 480] });

text.write(new Float32Array(4 * 4));
text.writeIndices(new Uint16Array([0, 1, 2, 2, 1, 3]));
textDraw.draw({ target, indices: 6 });
```

```ts
import { init } from "vgpu/mock";
import { box } from "vgpu/scene";

const gpu = await init();
const cube = gpu.mesh(box({ size: 2 }));
```

## Notes

- Layout is immutable; data is mutable. Changing formats, strides, topology, index format, or buffer identities requires a new mesh and a new draw.
- Auto stride is tight-packed and rounded up to 4 bytes. It never guesses padded data; pass `stride` when a writer emits padding.
- Slices share parent buffers and the same `vertexBufferLayouts` array identity so pipelines are shared.
- Draw-time range overrides use `DrawCallOptions.indices`, `firstIndex`, and `baseVertex`; non-indexed draws use existing `vertices` and `firstVertex`.
- Bundles bake counts and ranges at record time. Dynamic per-frame ranges need direct draws or bundle re-recording.
- `destroy()` only destroys buffers owned from `data`/`indices`; caller-owned `buffer` and `indexBuffer` remain caller-owned.
