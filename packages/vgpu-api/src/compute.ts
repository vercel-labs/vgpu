import type { Device } from "@vgpu/core";
import type { ShaderSource } from "@vgpu/wgsl";
import { reflectSource, type BindingInfo, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { entryMetadata } from "./entry-metadata.ts";
import { createBindGroupCache, identityKey, type BindGroupCache, type BindGroupIdentityPart } from "./bind-cache.ts";
import { createSetCore, bindGroupLayoutsForReflection, pipelineLayoutFor, type SetBag, type SetCore } from "./set-core.ts";
import { visibilityForEntries } from "./set-layouts.ts";
import type { Compute, ComputeOptions, DispatchOptions } from "./api-types.ts";
import { normalizeConstantsOptions, selectEntryPoint } from "./pipeline-store.ts";
import { indirectInvalidError, unsupportedError, writableStorageAliasingError } from "./errors.ts";
import { assertDeviceUsable } from "./lifecycle.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel } from "./live-kernel.ts";
import { renderService } from "./render-service.ts";
import { toWgsl } from "./shader-source.ts";
import { resolveIndirect } from "./indirect.ts";

/**
 * Compute pipeline for this gpu, ready to `set()` bindings and `dispatch()`.
 *
 * Each compute owns its own pipeline (no shared pipeline store), but it resolves the gpu's single
 * lazy bind group cache through the kernel, so a bind group built for a draw and one built here are
 * the same object when the resources match — and the cache is torn down once, in the service phase.
 */
export function compute(gpu: Gpu, source: string | ShaderSource, opts: ComputeOptions = {}): Compute {
  const kernel = liveKernel(gpu, "compute");
  return new ComputePipeline(kernel.device, toWgsl(source), opts, renderService(kernel).binds);
}

let nextComputeId = 1;

/**
 * Internal Ring-1 compute implementation behind `compute(gpu, source, opts)`.
 *
 * @internal
 */
export class ComputePipeline implements Compute {
  readonly id = nextComputeId++;
  readonly label: string;
  readonly reflection: Reflection;
  readonly entryPoint: string;
  readonly setCore: SetCore;
  readonly bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  readonly pipelineLayout: GPUPipelineLayout;
  readonly shaderModule: GPUShaderModule;
  readonly pipeline: GPUComputePipeline;
  readonly #storageBindings: readonly BindingInfo[];

  constructor(
    private readonly device: Device,
    readonly source: string,
    readonly opts: ComputeOptions = {},
    private readonly cache: BindGroupCache = createBindGroupCache(),
  ) {
    assertDeviceUsable(device, "Compute.constructor");
    this.label = opts.label ?? "compute";
    this.reflection = reflectSource(source, `${this.label}.wgsl`);
    // Entry selection runs before everything derived from the selected entry — binding visibility, bind group
    // layouts, and the active-binding set for storage aliasing all reflect the chosen variant.
    const entry = computeEntryPoint(this.reflection, this.label, opts.entry);
    this.entryPoint = entry.name;
    const { constants } = normalizeConstantsOptions(this.label, opts.constants, this.reflection.overrides, "compute");
    this.bindGroupLayouts = bindGroupLayoutsForReflection(device, this.label, this.reflection, visibilityForEntries(this.reflection.bindings, [entry]));
    this.pipelineLayout = pipelineLayoutFor(device, this.bindGroupLayouts);
    this.shaderModule = device.gpu.createShaderModule({ label: `${this.label}.shader`, code: source });
    // Each Compute owns its pipeline (no shared store), so constants join the descriptor directly; the record is
    // omitted when the option is absent to keep the descriptor byte-identical to before.
    this.pipeline = device.gpu.createComputePipeline({
      label: `${this.label}.pipeline`,
      layout: this.pipelineLayout,
      compute: { module: this.shaderModule, entryPoint: this.entryPoint, ...(constants ? { constants } : {}) },
    });
    this.setCore = createSetCore({ device, label: this.label, drawId: this.id, reflection: this.reflection, bindGroupLayouts: this.bindGroupLayouts, cache: this.cache });
    const active = new Set(entryMetadata(entry, "bindings", this.label).map((binding) => `${binding.group}:${binding.binding}`));
    this.#storageBindings = this.reflection.bindings.filter((binding) => binding.kind === "buffer" && binding.addressSpace === "storage" && active.has(`${binding.group}:${binding.binding}`));
    if (opts.set) this.set(opts.set);
  }

  set(values: SetBag): this {
    assertDeviceUsable(this.device, `${this.label}.set`);
    this.setCore.set(values);
    return this;
  }

  dispatch(x: number, y?: number, z?: number): void;
  dispatch(opts: DispatchOptions): void;
  dispatch(x: number | DispatchOptions, y?: number, z?: number): void {
    assertDeviceUsable(this.device, `${this.label}.dispatch`);
    const indirect = typeof x === "object" && x !== null ? this.#resolveIndirectDispatch(x, y, z) : undefined;
    this.#preflightAliasing();
    const encoder = this.device.gpu.createCommandEncoder({ label: `${this.label}.encoder` });
    const pass = encoder.beginComputePass({ label: `${this.label}.pass` });
    pass.setPipeline(this.pipeline);
    for (const binding of this.setCore.bindGroups()) pass.setBindGroup(binding.group, binding.bindGroup, binding.offsets);
    if (indirect) pass.dispatchWorkgroupsIndirect(indirect.buffer, indirect.offset);
    else pass.dispatchWorkgroups(x as number, y ?? 1, z ?? 1);
    pass.end();
    this.device.gpu.queue.submit([encoder.finish()]);
  }

  /** The GPU reads the workgroup counts from the buffer, so explicit counts alongside indirect are dead options and throw. */
  #resolveIndirectDispatch(opts: DispatchOptions, y?: number, z?: number): { readonly buffer: GPUBuffer; readonly offset: number } {
    const where = `${this.label}.dispatch`;
    if (y !== undefined || z !== undefined) throw indirectInvalidError(this.label, `indirect cannot be combined with explicit workgroup counts in the same call; the GPU reads the counts from the buffer, so the CPU-side values would be ignored.`, where);
    return resolveIndirect(this.label, where, opts.indirect, "dispatchWorkgroupsIndirect");
  }

  #preflightAliasing(): void {
    if (!this.#storageBindings.length) return;
    const buckets = new Map<string, { identity: BindGroupIdentityPart; writable: boolean }[]>();
    for (const binding of this.#storageBindings) {
      const state = this.setCore.bindingState(binding.name);
      if (!state) continue;
      const key = identityKey(state.identity);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ identity: state.identity, writable: binding.access !== "read" });
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      if (!bucket.some((entry) => entry.writable)) continue;
      throw writableStorageAliasingError(`${this.label}.dispatch`);
    }
  }
}

function computeEntryPoint(reflection: Reflection, label: string, name?: string): EntryPointInfo {
  // A named entry validates existence and stage inside selectEntryPoint (VGPU-ENTRY-INVALID); only the
  // no-name case can come back undefined, keeping today's error for a shader without any @compute entry.
  const entry = selectEntryPoint(label, reflection.entryPoints, "compute", name, "compute");
  if (!entry) throw unsupportedError(`${label}.compute`, "The compute shader requires a @compute entry point.");
  return entry;
}
