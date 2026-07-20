# Compute

Compute pipeline created by `gpu.compute()`. It uses the same WGSL reflection and `set()` ownership rules as render draws, then `dispatch(x, y?, z?)` encodes and submits one compute pass.

## Import

```ts
import type { Compute, ComputeOptions, StorageAccess, StorageBuffer } from "vgpu";
```

## Signature

```ts
interface ComputeOptions {
  readonly label?: string;
  readonly set?: Record<string, unknown>;
}

interface Compute {
  set(values: Record<string, unknown>): this;
  dispatch(x: number, y?: number, z?: number): void;
}

type StorageAccess = "read" | "read-write";

interface StorageBuffer {
  readonly size: number;
  readonly access: StorageAccess;
  read(): Promise<ArrayBuffer>;
  write(data: BufferSource): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.compute.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. Must include at least one `@compute` entry point. |
| gpu.compute.opts | `ComputeOptions` | ✖ | `{}` | Initial compute options. |
| opts.label | `string` | ✖ | `"compute"` | Used in shader reflection, GPU labels, and error `where` fields. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Initial `.set()` call. |
| compute.set.values | `Record<string, unknown>` | ✔ | — | Binding values by WGSL variable name. JS values are packed; buffers/resources are bound by identity. |
| compute.dispatch.x | `number` | ✔ | — | Workgroup count X passed to `dispatchWorkgroups`. |
| compute.dispatch.y | `number` | ✖ | `1` | Workgroup count Y. |
| compute.dispatch.z | `number` | ✖ | `1` | Workgroup count Z. |
| gpu.storage.bytes | `number` | ✔ | — | Byte size for a main API (`vgpu`) storage buffer. |
| gpu.storage.access | `StorageAccess` | ✖ | `"read-write"` | Stored on the resource facade and used by binding normalization. |
| storage.write.data | `BufferSource` | ✔ | — | `ArrayBuffer` or `ArrayBufferView`; writes at offset `0` in the public main API (`vgpu`) type. |

**Returns:** `gpu.compute()` returns `Compute`; `set()` returns the same `Compute`; `dispatch()` returns `void` after submitting; `gpu.storage()` returns a main API (`vgpu`) `StorageBuffer`; `StorageBuffer.read()` resolves an `ArrayBuffer` copy.

**Throws:** `VGPU-RING1-UNSUPPORTED` when the shader has no `@compute` entry point; `VGPU-R1-STORAGE-ALIASING` when the same storage buffer is bound more than once and at least one reflected binding is writable; `VGPU-R1-BINDING-NEVER-SET`, `VGPU-R1-OWNERSHIP-FLIP`, and `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` for binding errors; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `TypeError` if `StorageBuffer.write()` receives a non-buffer source.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const bytes = 4 * 16;
const src = gpu.storage(bytes, "read");
const dst = gpu.storage(bytes, "read-write");
src.write(new Float32Array(16));

const sim = gpu.compute(`
  @group(0) @binding(0) var<storage, read> src: array<vec4f>;
  @group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) id: vec3u) {
    dst[id.x] = src[id.x] + vec4f(1.0, 0.0, 0.0, 0.0);
  }
`, { label: "sim", set: { src, dst } });

sim.dispatch(4);
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const particles = gpu.pingPongStorage(1024);
const step = gpu.compute(`
  @group(0) @binding(0) var<storage, read> src: array<u32>;
  @group(0) @binding(1) var<storage, read_write> dst: array<u32>;
  @compute @workgroup_size(64)
  fn cs_main(@builtin(global_invocation_id) id: vec3u) { dst[id.x] = src[id.x]; }
`);

step.set({ src: particles.read, dst: particles.write });
step.dispatch(Math.ceil(256 / 64));
particles.swap();
```

## Notes

- Use `gpu.pingPongStorage(bytes)` when a compute step reads previous state and writes next state; binding the same writable storage identity twice is rejected before dispatch.
- Bindings use compute visibility only when statically reachable from the selected compute entry point; unused declarations stay in the layout with visibility `0`.
- Dispatch counts are forwarded to WebGPU; validate domain-specific bounds in your app.
- `gpu.storage()` creates storage buffers with `copy_src` and `copy_dst`, so they can be read back and rewritten from JS.
- **See also:** `Gpu.compute`, `Draw.set`, `SharedUniforms`, `Target`, `StorageBuffer` from `vgpu/core`.
