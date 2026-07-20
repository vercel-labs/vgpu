import type { Device } from "@vgpu/core";
import { reflectSource, type BindingInfo, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { createBindGroupCache, identityKey, type BindGroupCache, type BindGroupIdentityPart } from "./bind-cache.ts";
import { createSetCore, bindGroupLayoutsForReflection, pipelineLayoutFor, type SetBag, type SetCore } from "./set-core.ts";
import { visibilityForEntries } from "./set-layouts.ts";
import type { Compute, ComputeOptions } from "./gpu.ts";
import { unsupportedError, writableStorageAliasingError } from "./errors.ts";

let nextComputeId = 1;

/**
 * Internal Ring-1 compute implementation behind `Gpu.compute()`.
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
    this.label = opts.label ?? "compute";
    this.reflection = reflectSource(source, `${this.label}.wgsl`);
    const entry = computeEntryPoint(this.reflection, this.label);
    this.entryPoint = entry.name;
    this.bindGroupLayouts = bindGroupLayoutsForReflection(device, this.label, this.reflection, visibilityForEntries(this.reflection.bindings, [entry]));
    this.pipelineLayout = pipelineLayoutFor(device, this.bindGroupLayouts);
    this.shaderModule = device.gpu.createShaderModule({ label: `${this.label}.shader`, code: source });
    this.pipeline = device.gpu.createComputePipeline({
      label: `${this.label}.pipeline`,
      layout: this.pipelineLayout,
      compute: { module: this.shaderModule, entryPoint: this.entryPoint },
    });
    this.setCore = createSetCore({ device, label: this.label, drawId: this.id, reflection: this.reflection, bindGroupLayouts: this.bindGroupLayouts, cache: this.cache });
    this.#storageBindings = this.reflection.bindings.filter((binding) => binding.kind === "buffer" && binding.addressSpace === "storage");
    if (opts.set) this.set(opts.set);
  }

  set(values: SetBag): this {
    this.setCore.set(values);
    return this;
  }

  dispatch(x: number, y = 1, z = 1): void {
    this.#preflightAliasing();
    const encoder = this.device.gpu.createCommandEncoder({ label: `${this.label}.encoder` });
    const pass = encoder.beginComputePass({ label: `${this.label}.pass` });
    pass.setPipeline(this.pipeline);
    for (const binding of this.setCore.bindGroups()) pass.setBindGroup(binding.group, binding.bindGroup, binding.offsets);
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
    this.device.gpu.queue.submit([encoder.finish()]);
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

function computeEntryPoint(reflection: Reflection, label: string): EntryPointInfo {
  const entry = reflection.entryPoints.find((item) => item.stage === "compute");
  if (!entry) throw unsupportedError(`${label}.compute`, "The compute shader requires a @compute entry point.");
  return entry;
}
