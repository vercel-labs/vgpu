import { FRAME_COMPUTE, type FrameComputeProtocol } from "./frame-protocols.ts";
import type { UniformCapture } from "./frame-uniforms.ts";
import { deliverOperations, operationError, validateOperation, type OperationValidation } from "./native-validation.ts";
import { submittedWorkDone } from "./claim-validation.ts";
import type { Device } from "@vgpu/core";
import type { ShaderSource } from "@vgpu/wgsl";
import { reflectSource, type BindingInfo, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { entryMetadata } from "./entry-metadata.ts";
import { createBindGroupCache, identityKey, type BindGroupCache, type BindGroupIdentityPart } from "./bind-cache.ts";
import { createSetCore, bindGroupLayoutsForReflection, type SetBag, type SetCore } from "./set-core.ts";
import { visibilityForEntries } from "./set-layouts.ts";
import type { Compute, ComputeOptions, DispatchOptions } from "./api-types.ts";
import { computePipelineKeyOf, createPipelineStore, createShaderModuleCache, createPipelineLayoutCache, normalizeConstantsOptions, selectEntryPoint, type PipelineStore, type ShaderModuleCache, type PipelineLayoutCache } from "./pipeline-store.ts";
import { VGPUError, indirectInvalidError, unsupportedError, writableStorageAliasingError } from "./errors.ts";
import { assertDeviceUsable } from "./lifecycle.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel } from "./live-kernel.ts";
import { renderService } from "./render-service.ts";
import { toWgsl } from "./shader-source.ts";
import { resolveIndirect } from "./indirect.ts";

/**
 * Compute pipeline for this gpu, ready to `set()` bindings and `dispatch()`.
 *
 * Compute shares the gpu's lazy pipeline lifecycle and bind group caches. Entries remain scoped to their pipeline owner: matching
 * resources alone do not imply compatible layouts. The service tears down the shared cache once.
 */
export function compute(gpu: Gpu, source: string | ShaderSource, opts: ComputeOptions = {}): Compute {
  const kernel = liveKernel(gpu, "compute");
  const service = renderService(kernel);
  return new ComputePipeline(kernel.device, toWgsl(source), opts, service.binds, service.computePipelines, service.shaderModules, service.pipelineLayouts, error => kernel.reportError(error), promise => { void kernel.trackDelivery(promise); });
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
  readonly #descriptor: GPUComputePipelineDescriptor;
  readonly #key: string;
  readonly #entry: EntryPointInfo;
  readonly #storageBindings: readonly BindingInfo[];

  constructor(
    readonly device: Device,
    readonly source: string,
    readonly opts: ComputeOptions = {},
    private readonly cache: BindGroupCache = createBindGroupCache(),
    private readonly pipelines: PipelineStore<GPUComputePipeline> = createPipelineStore<GPUComputePipeline>(device),
    shaderModules: ShaderModuleCache = createShaderModuleCache(device),
    pipelineLayouts: PipelineLayoutCache = createPipelineLayoutCache(device),
    private readonly errorSink: (error: VGPUError) => void | Promise<void> = error => console.error(error),
    private readonly trackSettled?: (promise: Promise<unknown>) => void,
  ) {
    assertDeviceUsable(device, "Compute.constructor");
    this.label = opts.label ?? "compute";
    this.reflection = reflectSource(source, `${this.label}.wgsl`);
    // Entry selection runs before everything derived from the selected entry — binding visibility, bind group
    // layouts, and the active-binding set for storage aliasing all reflect the chosen variant.
    const entry = computeEntryPoint(this.reflection, this.label, opts.entry);
    this.entryPoint = entry.name;
    this.#entry = entry;
    const { constants, constantsKey } = normalizeConstantsOptions(this.label, opts.constants, this.reflection.overrides, "compute");
    this.bindGroupLayouts = bindGroupLayoutsForReflection(device, this.label, this.reflection, visibilityForEntries(this.reflection.bindings, [entry]));
    this.pipelineLayout = pipelineLayouts.get(this.bindGroupLayouts);
    this.shaderModule = shaderModules.get(source, `${this.label}.shader`);
    this.#descriptor = {
      label: `${this.label}.pipeline`, layout: this.pipelineLayout,
      compute: { module: this.shaderModule, entryPoint: this.entryPoint, ...(constants ? { constants: { ...constants } } : {}) },
    };
    this.#key = computePipelineKeyOf(this.shaderModule, this.pipelineLayout, this.entryPoint, constantsKey);
    this.setCore = createSetCore({ device, label: this.label, drawId: `compute:${this.id}`, reflection: this.reflection, bindGroupLayouts: this.bindGroupLayouts, cache: this.cache });
    const active = new Set(entryMetadata(entry, "bindings", this.label).map((binding) => `${binding.group}:${binding.binding}`));
    this.#storageBindings = this.reflection.bindings.filter((binding) => binding.kind === "buffer" && binding.addressSpace === "storage" && active.has(`${binding.group}:${binding.binding}`));
    if (opts.set) this.set(opts.set);
  }

  set(values: SetBag): this {
    assertDeviceUsable(this.device, `${this.label}.set`);
    this.setCore.set(values);
    return this;
  }

  get [FRAME_COMPUTE](): FrameComputeProtocol { return this; }
  get pipeline(): GPUComputePipeline | undefined { return this.pipelines.getReady(this.#key); }

  compile(): Promise<this> {
    assertDeviceUsable(this.device, `${this.label}.compile`);
    return this.pipelines.getAsync(this.#key, () => {
      this.#validateWorkgroup();
      return this.device.gpu.createComputePipelineAsync(this.#descriptor);
    }, this.#context("compile")).then(() => {
      assertDeviceUsable(this.device, `${this.label}.compile`);
      return this;
    });
  }

  compileSync(): this {
    assertDeviceUsable(this.device, `${this.label}.compileSync`);
    this.#validateWorkgroup();
    this.pipelines.getSync(this.#key, () => this.device.gpu.createComputePipeline(this.#descriptor), { ...this.#context("compileSync"), retry: true });
    return this;
  }

  dispatch(x: number, y?: number, z?: number): void;
  dispatch(opts: DispatchOptions): void;
  dispatch(x: number | DispatchOptions, y?: number, z?: number): void {
    assertDeviceUsable(this.device, `${this.label}.dispatch`);
    this.setCore.assertUsable();
    this.#preflightAliasing();
    const validations: OperationValidation[] = [];
    const encoder = this.device.gpu.createCommandEncoder({ label: `${this.label}.encoder` });
    const pass = validateOperation(this.device, validations, `${this.label}.begin`, () => encoder.beginComputePass({ label: `${this.label}.pass` }));
    try { this.encode(pass, x, y, z, validations); }
    catch (error) {
      try { validateOperation(this.device, [], `${this.label}.end`, () => pass.end()); } catch { /* preserve original error */ }
      throw error;
    }
    validateOperation(this.device, validations, `${this.label}.end`, () => pass.end());
    const command = validateOperation(this.device, validations, `${this.label}.finish`, () => encoder.finish());
    validateOperation(this.device, validations, `${this.label}.submit`, () => this.device.gpu.queue.submit([command]));
    const done = Promise.all([submittedWorkDone(this.device), deliverOperations(validations, this.errorSink)]).then(() => undefined, cause => this.errorSink(operationError(`${this.label}.completion`, cause)));
    this.trackSettled?.(done);
    void done.catch(() => undefined);
  }

  encode(pass: GPUComputePassEncoder, x: number | DispatchOptions, y: number | undefined, z: number | undefined, validations: OperationValidation[], capture?: UniformCapture): void {
    assertDeviceUsable(this.device, `${this.label}.dispatch`);
    const indirect = typeof x === "object" && x !== null ? this.#resolveIndirectDispatch(x, y, z) : undefined;
    if (!indirect) {
      for (const [axis, count] of [["x", x], ["y", y ?? 1], ["z", z ?? 1]] as const) {
        const limit = this.device.limits.maxComputeWorkgroupsPerDimension;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > limit) {
          throw new VGPUError({ code: "VGPU-COMPUTE-DISPATCH-INVALID", message: `Dispatch ${axis} must be an integer in [0, ${limit}]; received ${String(count)}.`, where: `${this.label}.dispatch`, detail: { label: this.label, entry: this.entryPoint, axis, limit }, fix: "Pass workgroup counts within the granted device limit." });
        }
      }
    }
    this.#preflightAliasing();
    this.#validateWorkgroup();
    const pipeline = this.pipelines.getSync(this.#key, () => this.device.gpu.createComputePipeline(this.#descriptor), this.#context("dispatch"));
    const origin = this.pipelines.failure(this.#key);
    validateOperation(this.device, validations, `${this.label}.dispatch`, () => {
      const bindings = this.setCore.bindGroups(capture);
      pass.setPipeline(pipeline);
      for (const binding of bindings) pass.setBindGroup(binding.group, binding.bindGroup, binding.offsets);
      if (indirect) pass.dispatchWorkgroupsIndirect(indirect.buffer, indirect.offset);
      else pass.dispatchWorkgroups(x as number, y ?? 1, z ?? 1);
    }, () => origin);
  }

  #context(method: string) { return { where: `${this.label}.${method}`, dependencies: [this.shaderModule, this.pipelineLayout] }; }

  #validateWorkgroup(): void {
    const size = this.#entry.workgroupSize;
    if (!size || !size.every(Number.isFinite)) return; // overrides/expressions remain native validation's responsibility
    const limits = this.device.limits;
    const checks = [
      ["maxComputeWorkgroupSizeX", size[0], limits.maxComputeWorkgroupSizeX],
      ["maxComputeWorkgroupSizeY", size[1], limits.maxComputeWorkgroupSizeY],
      ["maxComputeWorkgroupSizeZ", size[2], limits.maxComputeWorkgroupSizeZ],
      ["maxComputeInvocationsPerWorkgroup", size[0] * size[1] * size[2], limits.maxComputeInvocationsPerWorkgroup],
    ] as const;
    for (const [name, value, limit] of checks) if (!Number.isInteger(value) || value < 1 || value > limit) {
      throw new VGPUError({ code: "VGPU-COMPUTE-WORKGROUP-INVALID", message: `Compute workgroup requires ${value} for ${name}; granted limit is ${limit}.`, where: `${this.label}.compile`, detail: { label: this.label, entry: this.entryPoint, workgroupSize: [...size], limitName: name, limit }, fix: `Reduce @workgroup_size or request a supported ${name} using init({ requiredLimits: ... }).` });
    }
  }

  /** The GPU reads the workgroup counts from the buffer, so explicit counts alongside indirect are dead options and throw. */
  #resolveIndirectDispatch(opts: DispatchOptions, y?: number, z?: number): { readonly buffer: GPUBuffer; readonly offset: number } {
    const where = `${this.label}.dispatch`;
    if (y !== undefined || z !== undefined) throw indirectInvalidError(this.label, `indirect cannot be combined with explicit workgroup counts in the same call; the GPU reads the counts from the buffer, so the CPU-side values would be ignored.`, where);
    return resolveIndirect(this.label, where, opts.indirect, "dispatchWorkgroupsIndirect", this.device);
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
