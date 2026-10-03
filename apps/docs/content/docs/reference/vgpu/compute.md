---
title: "Compute"
description: "Compute pipeline created by `compute(gpu)` from a prepared `ShaderSource`. It reads bindings from the artifact's reflection and follows the same `set()` ownership rules as render draws, then `dispatch(x, y?, z?)` — or `dispatch({ indirect })` for GPU-driven counts — encodes and submits one compute pass."
---

## Import

```ts
import type { Compute, ComputeOptions, DispatchOptions, StorageAccess, StorageBuffer, StorageOptions } from "vgpu";
```

## Signature

```ts
interface ComputeOptions {
  readonly label?: string;
  readonly set?: Record<string, unknown>;
  readonly constants?: Readonly<Record<string, number | boolean>>;
  readonly entry?: string;
}

interface DispatchOptions {
  readonly indirect: StorageBuffer | { readonly buffer: StorageBuffer; readonly offset?: number };
}

interface Compute {
  set(values: Record<string, unknown>): this;
  compile(): Promise<this>;
  compileSync(): this;
  dispatch(x: number, y?: number, z?: number): void;
  dispatch(opts: DispatchOptions): void;
}

type StorageAccess = "read" | "read-write";

interface StorageOptions {
  readonly access?: StorageAccess;
  readonly indirect?: boolean;
}

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
| compute.source | `ShaderSource` | ✔ | — | Prepared `version: 2` artifact: a `.wgsl` import through the `@vgpu/wgsl` Vite/webpack loader, a prebuilt asset, or `prepareShader(wgsl)` from `@vgpu/wgsl/prepare`. Raw WGSL strings and `version: 1` artifacts are rejected. `compute(gpu)` copies and validates the metadata on every call; changing the artifact object afterwards does not affect an existing compute. Must include at least one `@compute` entry point. |
| compute.opts | `ComputeOptions` | ✖ | `{}` | Initial compute options. |
| opts.label | `string` | ✖ | `"compute"` | Used in GPU object labels (shader module and pipeline) and error `where` fields. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Initial `.set()` call. |
| opts.constants | `Readonly<Record<string, number \| boolean>>` | ✖ | WGSL defaults | Constructor-only values for WGSL `override` constants, applied to the compute stage. Use them to tune workgroup size per device or workload at pipeline creation: `@workgroup_size(WG)` with `override WG: u32`. Keying (`@id(N)` → decimal string of `N`) and number/boolean conversion match `DrawOptions.constants`. |
| opts.entry | `string` | ✖ | `cs_main` when declared, otherwise first `@compute` entry | Constructor-only entry point selection when one WGSL module packs several `@compute` kernels sharing structs and bindings (e.g. emit/simulate/compact). The name must exist in the shader with the `@compute` stage. Without a name, a unique compute entry is selected regardless of its name; with several entries, `cs_main` wins when declared, otherwise the first is used. Binding visibility, bind group layouts, and the storage-aliasing preflight follow the selected entry. |
| compute.set.values | `Record<string, unknown>` | ✔ | — | Binding values by WGSL variable name. JS values are packed; buffers/resources are bound by identity. `texture_storage_*` bindings take a `Texture` from `texture(gpu)` whose `usage` includes `storage_binding`. A `Surface` is rejected in every slot with `VGPU-SURFACE-NOT-BINDABLE`. |
| compute.dispatch.x | `number` | ✔ | — | Workgroup count X passed to `dispatchWorkgroups`. |
| compute.dispatch.y | `number` | ✖ | `1` | Workgroup count Y. |
| compute.dispatch.z | `number` | ✖ | `1` | Workgroup count Z. |
| compute.dispatch.opts.indirect | `StorageBuffer \| { buffer, offset? }` | ✔ in the overload | — | GPU-driven dispatch via `dispatchWorkgroupsIndirect`: the GPU reads `[x, y, z]` workgroup counts (3 tightly packed u32, 12 bytes) from the buffer at the byte `offset` (default `0`). Use it when an earlier pass decides how much work exists — variable particle populations, stream compaction. Requires a buffer created with `storage(gpu, bytes, { indirect: true })`; `offset` must be a multiple of 4 and `offset + 12 <= size`. Cannot be combined with explicit counts. |
| storage.bytes | `number` | ✔ | — | Byte size for a main API (`vgpu`) storage buffer. |
| storage.access | `StorageAccess \| StorageOptions` | ✖ | `"read-write"` | Access string, or a `StorageOptions` bag with `access` and `indirect`. Stored on the resource facade and used by binding normalization. |
| storage.access.indirect | `boolean` | ✖ | `false` | Appends the `"indirect"` buffer usage so the buffer can supply GPU-read draw/dispatch arguments. |
| storage.write.data | `BufferSource` | ✔ | — | `ArrayBuffer` or `ArrayBufferView`; writes at offset `0` in the public main API (`vgpu`) type. |

**Returns:** `compute(gpu)` returns `Compute`; `set()` and `compileSync()` return the same `Compute`; `compile()` resolves to that object after successful validation; `dispatch()` returns `void` after submitting; `storage(gpu)` returns a main API (`vgpu`) `StorageBuffer`; `StorageBuffer.read()` resolves an `ArrayBuffer` copy.

**Throws:** `VGPU-RING1-UNSUPPORTED` when the shader has no `@compute` entry point; `VGPU-INDIRECT-INVALID` at dispatch time for a malformed `indirect` (neither a `StorageBuffer` nor `{ buffer, offset? }`), a buffer created without the indirect flag (use `storage(gpu, bytes, { indirect: true })`), an `offset` that is not a non-negative integer multiple of 4, counts that do not fit the buffer (`offset + 12 > size`), or `indirect` combined with explicit workgroup counts in the same call; `VGPU-CONSTANTS-INVALID` for a malformed `constants` option (non-object value, a key that matches no override in the shader — the message lists the available overrides — or a value that is neither a finite number nor a boolean), and for an override declared without a default that `constants` does not provide; `VGPU-ENTRY-INVALID` for a non-string `entry`, a name that matches no entry point in the shader, or a name whose entry point is not `@compute` — the message lists the shader's available entry points with their stages; `VGPU-SET-VALUE-INVALID` when a JS-owned binding has the wrong reflected shape or an out-of-range integer; `VGPU-R1-STORAGE-ALIASING` when the same storage buffer is bound more than once and at least one reflected binding is writable; `VGPU-R1-BINDING-NEVER-SET`, `VGPU-R1-OWNERSHIP-FLIP`, and `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` for binding errors, including storage textures without `storage_binding` usage or whose format/dimension differs from WGSL; `VGPU-SURFACE-NOT-BINDABLE` when a `Surface` is passed as a binding value in `opts.set` or a later `set()`, inside or outside a frame — `where` is `<label>.<binding>`, vgpu throws before reading the surface's attachments or acquiring a canvas texture, and the rejected binding keeps its previous value (keys earlier in the same `set()` call are already applied); render to an offscreen target and bind that target or its texture, and use the `Surface` only as a render destination; `VGPU-SHADER-SOURCE-UNPREPARED` when `source` is a raw WGSL string or a `version: 1` artifact (import the `.wgsl` file through a compatible `@vgpu/wgsl` loader, rebuild prebuilt assets, or pass `prepareShader(wgsl)` from `@vgpu/wgsl/prepare`); `VGPU-SHADER-SOURCE-VERSION` when `source.version` is an integer other than `2` (the message names the received version, the supported version, and the artifact's `producer`; align the `@vgpu/wgsl` tooling and `vgpu` runtime versions, then regenerate); `VGPU-SHADER-SOURCE-INVALID` when `source` is not an object, `version` is missing or not an integer, a required field is missing, accessor-backed, or malformed, the reflection metadata is inconsistent, or `sourceChecksum` does not match `wgsl` (structured detail gives the field `path` and the `reason`; regenerate the artifact with a supported producer); these three throw synchronously from `compute(gpu)`, before any compute option is validated; `TypeError` if `StorageBuffer.write()` receives a non-buffer source.

## Examples

```wgsl
// sim.wgsl
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(1)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  dst[id.x] = src[id.x] + vec4f(1.0, 0.0, 0.0, 0.0);
}
```

```ts
import { init, compute, storage } from "vgpu/mock";
import simShader from "./sim.wgsl"; // prepared at build time by the @vgpu/wgsl loader

const gpu = await init();
const bytes = 4 * 16;
const src = storage(gpu, bytes, "read");
const dst = storage(gpu, bytes, "read-write");
src.write(new Float32Array(16));

const sim = compute(gpu, simShader, { label: "sim", set: { src, dst } });

sim.dispatch(4);
```

The loader turns `sim.wgsl` into a prepared `ShaderSource`, so the app bundle ships no WGSL parser. The remaining examples keep their WGSL inline and wrap it in `prepareShader()` from `@vgpu/wgsl/prepare`; calling it in browser code bundles the parser, so prefer `.wgsl` imports for static shaders.

```ts
import { init, compute, pingPongStorage } from "vgpu/mock";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const particles = pingPongStorage(gpu, 1024);
const step = compute(gpu, prepareShader(`
  @group(0) @binding(0) var<storage, read> src: array<u32>;
  @group(0) @binding(1) var<storage, read_write> dst: array<u32>;
  @compute @workgroup_size(64)
  fn cs_main(@builtin(global_invocation_id) id: vec3u) { dst[id.x] = src[id.x]; }
`));

step.set({ src: particles.read, dst: particles.write });
step.dispatch(Math.ceil(256 / 64));
particles.swap();
```

```ts
import { init, compute, storage } from "vgpu/mock";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const wg = 64; // tune per device or workload without editing WGSL
const data = storage(gpu, 4 * 256);
const scale = compute(gpu, prepareShader(`
  override WG: u32 = 64;
  @group(0) @binding(0) var<storage, read_write> data: array<f32>;
  @compute @workgroup_size(WG)
  fn cs_main(@builtin(global_invocation_id) id: vec3u) { data[id.x] = data[id.x] * 2.0; }
`), { constants: { WG: wg }, set: { data } });

scale.dispatch(Math.ceil(256 / wg));
```

One JS constant drives both the pipeline's workgroup size and the dispatch math, so retuning `wg` cannot desynchronize them.

```ts
import { init, compute, storage } from "vgpu/mock";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const alive = storage(gpu, 4, "read");             // live-particle count, e.g. from emission/compaction
const args = storage(gpu, 12, { indirect: true }); // [x, y, z] workgroup counts
const particles = storage(gpu, 4 * 1024);

const prepare = compute(gpu, prepareShader(`
  @group(0) @binding(0) var<storage, read> alive: u32;
  @group(0) @binding(1) var<storage, read_write> args: array<u32, 3>;
  @compute @workgroup_size(1) fn cs_main() {
    args[0] = (alive + 63u) / 64u; args[1] = 1u; args[2] = 1u; // one workgroup per 64 live particles
  }
`), { set: { alive, args } });

const step = compute(gpu, prepareShader(`
  @group(0) @binding(0) var<storage, read_write> particles: array<f32>;
  @compute @workgroup_size(64)
  fn cs_main(@builtin(global_invocation_id) id: vec3u) { particles[id.x] = particles[id.x] + 0.016; }
`), { set: { particles } });

prepare.dispatch(1);               // GPU computes how much work exists
step.dispatch({ indirect: args }); // GPU reads the counts; JS never sees them
```

GPU-driven dispatch: the first pass writes the workgroup counts from GPU-side state, so the population can vary every frame without a readback stall.

## Notes

- `compute(gpu)` never parses WGSL; it reads bindings, entry points, and workgroup sizes from the artifact's reflection. `prepareShader()` runs the parser, so call it once per source revision — outside `frame()`/`frameLoop()` callbacks and hot paths — and reuse the artifact for every compute built from that source.
- Each `compute(gpu)` call validates the artifact and keeps a private frozen copy; unknown additive fields are ignored. `sourceChecksum` only detects a replaced `wgsl` string, not stale `reflection` produced by older tooling, so regenerate prepared artifacts whenever the WGSL source or `@vgpu/wgsl` tooling changes.
- Use explicit `dispatch(x, y, z)` when the CPU already knows stable workgroup counts. Use `dispatch({ indirect })` when a preceding GPU pass decides the count (compaction, particles), so no CPU readback is needed.
- Declare storage `read` for source-only buffers and `read-write` for state that a kernel updates. For iterative simulation, bind `pingPongStorage(gpu, ...)` read/write pairs and swap after each step instead of aliasing one writable buffer.
- `StorageBuffer.read()` is for tests, snapshots, and diagnostics; avoid awaiting it in a hot loop unless CPU synchronization is intentional.
- Use `pingPongStorage(gpu, bytes)` when a compute step reads previous state and writes next state; binding the same writable storage identity twice is rejected before dispatch.
- Storage textures come from `texture(gpu, opts)`. `set()` validates their usage, format, and dimension against the reflected `texture_storage_*` declaration; a render `Target` is not accepted, and a `Surface` throws `VGPU-SURFACE-NOT-BINDABLE` in any slot.
- To read a rendered image in a kernel, render it into an offscreen `Target` and bind that target (it follows the attachment across `resize(...)`) or `sceneTarget.color` (that exact texture; rebind after a resize) to a sampled `texture_2d<f32>` binding. To write an image from compute, bind a storage `Texture` created with `usage: ["storage_binding", "texture_binding"]`, then present it by sampling it in an effect drawn into a surface pass.
- Bindings use compute visibility only when statically reachable from the selected compute entry point; unused declarations stay in the layout with visibility `0`.
- `constants` maps to `GPUProgrammableStage.constants` of the compute stage. Options are captured at construction; recreate the compute to change them. Pipeline creation is lazy: use `compile()`, `compileSync()`, or first dispatch.
- Direct dispatch counts must be finite integers from zero through `gpu.device.limits.maxComputeWorkgroupsPerDimension`. Zero is legal. Workgroup axes and their product must fit the granted device limits; unresolved WGSL expressions are validated natively. Default examples use portable sizes. For a larger workgroup, explicitly request the supported axis and `maxComputeInvocationsPerWorkgroup` limits using `init({ requiredLimits: ... })`.
- Write indirect counts from another compute pass (bind the same buffer as storage) or from JS via `write()`. The same option shape drives GPU-driven draws via `DrawCallOptions.indirect`.
- `storage(gpu)` creates storage buffers with `copy_src` and `copy_dst`, so they can be read back and rewritten from JS.
- **See also:** `compute`, `ShaderSource`, `prepareShader` (`@vgpu/wgsl/prepare`), `Draw.set`, `SharedUniforms`, `Target`, `StorageBuffer` from `vgpu/core`.

## Preparation and frame-owned execution

`await compute.compile()` uses asynchronous native compilation. Its rejection belongs to the returned promise; handle it with `try`/`catch`. `compileSync()` creates synchronously, but native validation may arrive later through `gpu.onError`. `gpu.settled()` waits for tracked preparation and error delivery and never rejects. Neither `settled()` nor buffer readback proves successful execution.

```ts
import { init, compute, frame, storage } from "vgpu/mock";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const data = storage(gpu, 4);
const simulation = compute(gpu, prepareShader(`
  @group(0) @binding(0) var<storage, read_write> data: array<f32>;
  @group(0) @binding(1) var<uniform> dt: f32;
  @compute @workgroup_size(1) fn main() { data[0] += dt; }
`), { set: { data, dt: 0.01 } });
await simulation.compile();
const current = frame(gpu, f => f.computePass({ label: "simulation" }, pass => {
  pass.dispatch(simulation, 1);
  simulation.set({ dt: 0.02 });
  pass.dispatch(simulation, 1);
}));
await current.done;
gpu.dispose();
```

`Frame.computePass()` encodes into the frame's encoder; multiple dispatches and render passes submit once, in pass order. Canceling the frame discards its encoded compute commands. Standalone `simulation.dispatch()` always submits independently, even inside a frame callback.

Each direct frame draw/dispatch captures managed uniform values when encoded. An equal `set()` (same packed bytes) reuses the snapshot already captured in that frame. Storage buffers remain live, so later dispatches observe earlier GPU writes, and every `set()` writes JS-owned storage values even when equal. `uniforms()` adopted as storage, raw buffers, claimed bind groups, and render bundles retain live buffer semantics. Ordinary host writes are not ordered frame commands.

Raw `GPUBuffer` / `{ buffer, offset?, size? }` values bind as live resources (see "Raw buffer bindings" in `Draw`). The storage aliasing check is per buffer: two ranges of one buffer with a writable binding throw `VGPU-R1-STORAGE-ALIASING`.

Additional errors: `VGPU-COMPUTE-DISPATCH-INVALID` for invalid direct counts; `VGPU-COMPUTE-WORKGROUP-INVALID` for known workgroup limit violations; `VGPU-COMPILE-FAILED` for pipeline creation/validation failures; `VGPU-COMPUTE-VALIDATION` for asynchronous compute execution validation. Automatic use of a failed pipeline throws; explicit compilation can retry.
