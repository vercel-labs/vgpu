import { bind, Buffer, createBindGroup, createBindGroupLayout, type Device } from "@vgpu/core";

export interface StorageBufferOptions {
  /** Byte size of the storage buffer. Must be a positive number. Storage buffers may be far larger than uniforms (up to the adapter's `maxStorageBufferBindingSize`, typically 128 MiB). */
  readonly size: number;
  /** Optional debug label forwarded to the buffer, bind group layout, and bind group. */
  readonly label?: string;
  /**
   * Whether the shader only reads the buffer (`"read"`, the default → `var<storage, read>`)
   * or also writes it (`"read-write"` → `var<storage, read_write>`). This selects the
   * bind group layout entry type (`"read-only-storage"` vs `"storage"`) and changes the
   * default {@link StorageBufferOptions.visibility}.
   */
  readonly access?: "read" | "read-write";
  /**
   * Shader stages that access binding 0. Defaults to `FRAGMENT | COMPUTE` for both access modes —
   * no `VERTEX`. Read-write storage is forbidden in the vertex stage; read-only storage is allowed
   * there but `maxStorageBuffersInVertexStage` is 0 on many adapters (software/CI Vulkan, some
   * mobile GPUs), so vertex-stage storage is opt-in: pass `visibility` explicitly and raise that
   * limit via `requiredLimits`. Ignored when {@link StorageBufferOptions.bindGroupLayout} is provided.
   */
  readonly visibility?: GPUShaderStageFlags;
  /**
   * Reuse a pipeline-owned bind group layout instead of creating one.
   * The layout's binding 0 must be a storage buffer compatible with `size` and `access`.
   */
  readonly bindGroupLayout?: GPUBindGroupLayout;
}

// Both access modes default to FRAGMENT | COMPUTE (no VERTEX):
// - read-write storage is ILLEGAL in the vertex stage (WebGPU forbids it).
// - read-only storage IS legal in vertex, but maxStorageBuffersInVertexStage is 0 on many adapters
//   (software/CI Vulkan, some mobile GPUs), so a VERTEX-visible default would silently invalidate
//   the layout there (the draw no-ops). Vertex-stage read-only storage is opt-in: pass `visibility`
//   explicitly AND raise the limit via requiredLimits when requesting the device.
const defaultVisibility = ((globalThis.GPUShaderStage?.FRAGMENT ?? 2) | (globalThis.GPUShaderStage?.COMPUTE ?? 4)) as GPUShaderStageFlags;

/**
 * A single stable storage buffer for one render (or compute) pass, rewritten as needed.
 *
 * @remarks
 * `StorageBuffer` is the storage-buffer counterpart to {@link Uniform}. Reach for it when
 * the data is too large or too dynamic for a uniform: arrays, runtime-sized data, particle
 * state, lookup tables. Storage buffers can be much bigger than uniforms (up to the adapter's
 * `maxStorageBufferBindingSize`, typically 128 MiB, versus a uniform's 64 KiB) and can be
 * written by the shader when `access: "read-write"`.
 *
 * Like `Uniform`, it owns exactly one buffer at binding 0 with a fixed (non-dynamic) offset,
 * and the caller decides when to {@link StorageBuffer.write}. Unlike {@link UniformPool} — a
 * dynamic-offset ring allocator for many small per-draw uniforms — there is no dynamic offset
 * and the bind group never moves.
 *
 * `access` controls the layout entry type; both modes default to `FRAGMENT | COMPUTE` visibility:
 * - `"read"` (default) → `var<storage, read>`, layout type `"read-only-storage"`.
 * - `"read-write"` → `var<storage, read_write>`, layout type `"storage"`.
 * Neither default includes `VERTEX`: read-write storage is forbidden in the vertex stage, and
 * read-only storage — though legal there — needs `maxStorageBuffersInVertexStage > 0`, which is 0
 * on many adapters (software/CI Vulkan, some mobile GPUs). For vertex-stage read-only storage, pass
 * `visibility: VERTEX | …` explicitly and raise the limit via `requiredLimits`; do not rely on the default.
 *
 * @example
 * ```ts
 * // A read-only array the fragment shader samples (var<storage, read> values: array<f32>):
 * const storage = new StorageBuffer(device, { size: 4 * count, label: "values" });
 * storage.write(new Float32Array(values));
 * pass.setBindGroup(0, storage.bindGroup);
 *
 * // A compute-written scratch buffer (var<storage, read_write> out: array<u32>):
 * const scratch = new StorageBuffer(device, { size: 4 * count, access: "read-write" });
 * ```
 */
export class StorageBuffer {
  readonly size: number;
  readonly access: "read" | "read-write";
  readonly buffer: Buffer;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  #destroyed = false;

  constructor(readonly device: Device, opts: StorageBufferOptions) {
    this.size = opts.size;
    this.access = opts.access ?? "read";
    this.buffer = device.createBuffer({ size: opts.size, usage: ["storage", "copy_dst"], label: opts.label });
    const visibility = opts.visibility ?? defaultVisibility;
    const entry = this.access === "read-write"
      ? bind.storage(0, visibility, { minBindingSize: opts.size })
      : bind.readonlyStorage(0, visibility, { minBindingSize: opts.size });
    this.bindGroupLayout = opts.bindGroupLayout ?? createBindGroupLayout(device, {
      label: opts.label ? `${opts.label}.bgl` : undefined,
      entries: [entry],
    });
    this.bindGroup = createBindGroup(device, {
      label: opts.label ? `${opts.label}.bg` : undefined,
      layout: this.bindGroupLayout,
      entries: [bind.resource(0, this.buffer)],
    });
  }

  /** The underlying storage `GPUBuffer`. */
  get gpu(): GPUBuffer {
    return this.buffer.gpu;
  }

  /**
   * Upload `data` to the buffer via `queue.writeBuffer`. No dynamic offset; the
   * bind group is unchanged. Call only when the contents actually change.
   */
  write(data: BufferSource, offset = 0): void {
    this.buffer.write(data, offset);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.buffer.destroy();
  }

  dispose(): void {
    this.destroy();
  }
}
