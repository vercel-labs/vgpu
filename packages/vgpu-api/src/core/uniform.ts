import { bind, Buffer, createBindGroup, createBindGroupLayout, type Device } from "@vgpu/core";

export interface UniformOptions {
  /** Byte size of the uniform buffer. Must be a positive number. */
  readonly size: number;
  /** Optional debug label forwarded to the buffer, bind group layout, and bind group. */
  readonly label?: string;
  /**
   * Shader stages that read binding 0. Defaults to `VERTEX | FRAGMENT`.
   * Ignored when {@link UniformOptions.bindGroupLayout} is provided.
   */
  readonly visibility?: GPUShaderStageFlags;
  /**
   * Reuse a pipeline-owned bind group layout instead of creating one.
   * The layout's binding 0 must be a uniform buffer compatible with `size`.
   */
  readonly bindGroupLayout?: GPUBindGroupLayout;
}

const defaultVisibility = ((globalThis.GPUShaderStage?.VERTEX ?? 1) | (globalThis.GPUShaderStage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;

/**
 * A single stable uniform buffer for one render pass, rewritten per frame.
 *
 * @remarks
 * Unlike {@link UniformPool} (a dynamic-offset ring allocator built for many
 * per-draw uniforms), `Uniform` owns exactly one uniform buffer at binding 0 with
 * a fixed (non-dynamic) offset. The caller decides when to {@link Uniform.write}
 * — typically gating on real changes — and the bind group never moves. This fits
 * the "one camera/globals buffer per pass" case where a dynamic-offset binding
 * would needlessly mark the layout `hasDynamicOffset` and re-upload every frame.
 *
 * @example
 * ```ts
 * const uniform = new Uniform(device, { size: 64, label: "globals" });
 * // per frame, only when inputs changed:
 * uniform.write(globalsBytes);
 * pass.setBindGroup(0, uniform.bindGroup);
 * ```
 */
export class Uniform {
  readonly size: number;
  readonly buffer: Buffer;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  #destroyed = false;

  constructor(readonly device: Device, opts: UniformOptions) {
    this.size = opts.size;
    this.buffer = device.createBuffer({ size: opts.size, usage: ["uniform", "copy_dst"], label: opts.label });
    this.bindGroupLayout = opts.bindGroupLayout ?? createBindGroupLayout(device, {
      label: opts.label ? `${opts.label}.bgl` : undefined,
      entries: [bind.uniform(0, opts.visibility ?? defaultVisibility, { minBindingSize: opts.size })],
    });
    this.bindGroup = createBindGroup(device, {
      label: opts.label ? `${opts.label}.bg` : undefined,
      layout: this.bindGroupLayout,
      entries: [bind.resource(0, this.buffer)],
    });
  }

  /** The underlying uniform `GPUBuffer`. */
  get gpu(): GPUBuffer {
    return this.buffer.gpu;
  }

  /**
   * Upload `data` to the buffer via `queue.writeBuffer`. No dynamic offset; the
   * bind group is unchanged. Call only when the uniform contents actually change.
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
