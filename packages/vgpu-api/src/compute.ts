import { FRAME_COMPUTE, type FrameComputeProtocol } from "./frame-protocols.ts";
import type { UniformCapture } from "./frame-uniforms.ts";
import { deliverOperations, operationError, validateOperation, type OperationValidation } from "./native-validation.ts";
import { submittedWorkDone } from "./claim-validation.ts";
import type { Device } from "@vgpu/core";
import type { ShaderSource } from "@vgpu/wgsl";
import { reflectSource, type BindingInfo, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { entryMetadata } from "./entry-metadata.ts";
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { createSetCore, bindGroupLayoutsForReflection, type SetBag, type SetCore } from "./set-core.ts";
import { visibilityForEntries } from "./set-layouts.ts";
import type { Compute, ComputeOptions, DispatchOptions } from "./api-types.ts";
import { computePipelineKeyOf, createPipelineStore, createShaderModuleCache, createPipelineLayoutCache, normalizeConstantsOptions, selectEntryPoint, type PipelineStore, type ShaderModuleCache, type PipelineLayoutCache } from "./pipeline-store.ts";
import { VGPUError, computeDisposedError, indirectInvalidError, unsupportedError, writableStorageAliasingError } from "./errors.ts";
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

type ComputeState = {
  readonly device: Device;
  readonly reflection: Reflection;
  readonly entryPoint: string;
  readonly setCore: SetCore;
  readonly bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  readonly pipelineLayout: GPUPipelineLayout;
  readonly shaderModule: GPUShaderModule;
  readonly descriptor: GPUComputePipelineDescriptor;
  readonly key: string;
  readonly entry: EntryPointInfo;
  readonly storageBindings: readonly BindingInfo[];
  readonly pipelines: PipelineStore<GPUComputePipeline>;
  readonly errorSink: (error: VGPUError) => void | Promise<void>;
  readonly trackSettled?: (promise: Promise<unknown>) => void;
};

type ComputeTombstone = { readonly disposed: true; readonly label: string };
const computeStates = new WeakMap<ComputePipeline, ComputeState | ComputeTombstone>();

/**
 * Internal Ring-1 compute implementation behind `compute(gpu, source, opts)`.
 *
 * @internal
 */
export class ComputePipeline implements Compute {
  readonly id = nextComputeId++;
  readonly label: string;

  constructor(
    device: Device,
    source: string,
    opts: ComputeOptions = {},
    cache: BindGroupCache = createBindGroupCache(),
    pipelines: PipelineStore<GPUComputePipeline> = createPipelineStore<GPUComputePipeline>(device),
    shaderModules: ShaderModuleCache = createShaderModuleCache(device),
    pipelineLayouts: PipelineLayoutCache = createPipelineLayoutCache(device),
    errorSink: (error: VGPUError) => void | Promise<void> = error => console.error(error),
    trackSettled?: (promise: Promise<unknown>) => void,
  ) {
    assertDeviceUsable(device, "Compute.constructor");
    this.label = opts.label ?? "compute";
    const label = this.label;
    const reflection = reflectSource(source, `${label}.wgsl`);
    // Entry selection runs before everything derived from the selected entry — binding visibility, bind group
    // layouts, and the active-binding set for storage aliasing all reflect the chosen variant.
    const entry = computeEntryPoint(reflection, label, opts.entry);
    const entryPoint = entry.name;
    const { constants, constantsKey } = normalizeConstantsOptions(label, opts.constants, reflection.overrides, "compute");
    const bindGroupLayouts = bindGroupLayoutsForReflection(device, label, reflection, visibilityForEntries(reflection.bindings, [entry]));
    const pipelineLayout = pipelineLayouts.get(bindGroupLayouts);
    const shaderModule = shaderModules.get(source, `${label}.shader`);
    const descriptor: GPUComputePipelineDescriptor = {
      label: `${label}.pipeline`, layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint, ...(constants ? { constants: { ...constants } } : {}) },
    };
    const key = computePipelineKeyOf(shaderModule, pipelineLayout, entryPoint, constantsKey);
    const setCore = createSetCore({ device, label, reflection, bindGroupLayouts, cache, disposedError: operation => computeDisposedError(label, operation) });
    const active = new Set(entryMetadata(entry, "bindings", label).map((binding) => `${binding.group}:${binding.binding}`));
    const storageBindings = reflection.bindings.filter((binding) => binding.kind === "buffer" && binding.addressSpace === "storage" && active.has(`${binding.group}:${binding.binding}`));
    computeStates.set(this, { device, reflection, entryPoint, setCore, bindGroupLayouts, pipelineLayout, shaderModule, descriptor, key, entry, storageBindings, pipelines, errorSink, trackSettled });
    if (opts.set) this.set(opts.set);
  }

  get device(): Device { return computeState(this, "device").device; }
  get reflection(): Reflection { return computeState(this, "reflection").reflection; }
  get entryPoint(): string { return computeState(this, "entryPoint").entryPoint; }
  get setCore(): SetCore { return computeState(this, "setCore").setCore; }
  get bindGroupLayouts(): ReadonlyMap<number, GPUBindGroupLayout> { return computeState(this, "bindGroupLayouts").bindGroupLayouts; }
  get pipelineLayout(): GPUPipelineLayout { return computeState(this, "pipelineLayout").pipelineLayout; }
  get shaderModule(): GPUShaderModule { return computeState(this, "shaderModule").shaderModule; }

  dispose(): void {
    const state = computeStateRecord(this);
    if ("disposed" in state) return;
    computeStates.set(this, { disposed: true, label: this.label });
    state.setCore.dispose();
  }

  set(values: SetBag): this {
    const state = computeState(this, "set");
    assertDeviceUsable(state.device, `${this.label}.set`);
    state.setCore.set(values);
    return this;
  }

  get [FRAME_COMPUTE](): FrameComputeProtocol { computeState(this, "frame"); return this; }
  get pipeline(): GPUComputePipeline | undefined {
    const state = computeState(this, "pipeline");
    return state.pipelines.getReady(state.key);
  }

  compile(): Promise<this> {
    const state = computeState(this, "compile");
    assertDeviceUsable(state.device, `${this.label}.compile`);
    const workgroup = computeWorkgroupValidation(this.label, state);
    const { descriptor, device, key, pipelines } = state;
    const promise = pipelines.getAsync(key, () => {
      validateComputeWorkgroup(workgroup);
      return device.gpu.createComputePipelineAsync(descriptor);
    }, this.#context(state, "compile"));
    return promise.then(
      () => {
        const current = computeState(this, "compile");
        assertDeviceUsable(current.device, `${this.label}.compile`);
        return this;
      },
      error => {
        computeState(this, "compile");
        throw error;
      },
    );
  }

  compileSync(): this {
    const state = computeState(this, "compileSync");
    assertDeviceUsable(state.device, `${this.label}.compileSync`);
    validateComputeWorkgroupState(this.label, state);
    state.pipelines.getSync(state.key, () => state.device.gpu.createComputePipeline(state.descriptor), { ...this.#context(state, "compileSync"), retry: true });
    return this;
  }

  dispatch(x: number, y?: number, z?: number): void;
  dispatch(opts: DispatchOptions): void;
  dispatch(x: number | DispatchOptions, y?: number, z?: number): void {
    const state = computeState(this, "dispatch");
    assertDeviceUsable(state.device, `${this.label}.dispatch`);
    state.setCore.preflight();
    this.#preflightAliasing(state);
    const validations: OperationValidation[] = [];
    const encoder = state.device.gpu.createCommandEncoder({ label: `${this.label}.encoder` });
    const pass = validateOperation(state.device, validations, `${this.label}.begin`, () => encoder.beginComputePass({ label: `${this.label}.pass` }));
    try { this.encode(pass, x, y, z, validations); }
    catch (error) {
      try { validateOperation(state.device, [], `${this.label}.end`, () => pass.end()); } catch { /* preserve original error */ }
      throw error;
    }
    validateOperation(state.device, validations, `${this.label}.end`, () => pass.end());
    const command = validateOperation(state.device, validations, `${this.label}.finish`, () => encoder.finish());
    validateOperation(state.device, validations, `${this.label}.submit`, () => state.device.gpu.queue.submit([command]));
    const { device, errorSink, trackSettled } = state;
    const done = Promise.all([submittedWorkDone(device), deliverOperations(validations, errorSink)]).then(() => undefined, cause => errorSink(operationError(`${this.label}.completion`, cause)));
    trackSettled?.(done);
    void done.catch(() => undefined);
  }

  encode(pass: GPUComputePassEncoder, x: number | DispatchOptions, y: number | undefined, z: number | undefined, validations: OperationValidation[], capture?: UniformCapture): void {
    const state = computeState(this, "encode");
    assertDeviceUsable(state.device, `${this.label}.dispatch`);
    state.setCore.preflight();
    const indirect = typeof x === "object" && x !== null ? this.#resolveIndirectDispatch(state, x, y, z) : undefined;
    if (!indirect) {
      for (const [axis, count] of [["x", x], ["y", y ?? 1], ["z", z ?? 1]] as const) {
        const limit = state.device.limits.maxComputeWorkgroupsPerDimension;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > limit) {
          throw new VGPUError({ code: "VGPU-COMPUTE-DISPATCH-INVALID", message: `Dispatch ${axis} must be an integer in [0, ${limit}]; received ${String(count)}.`, where: `${this.label}.dispatch`, detail: { label: this.label, entry: this.entryPoint, axis, limit }, fix: "Pass workgroup counts within the granted device limit." });
        }
      }
    }
    this.#preflightAliasing(state);
    validateComputeWorkgroupState(this.label, state);
    const pipeline = state.pipelines.getSync(state.key, () => state.device.gpu.createComputePipeline(state.descriptor), this.#context(state, "dispatch"));
    const origin = state.pipelines.failure(state.key);
    validateOperation(state.device, validations, `${this.label}.dispatch`, () => {
      const bindings = state.setCore.bindGroups(capture);
      pass.setPipeline(pipeline);
      for (const binding of bindings) pass.setBindGroup(binding.group, binding.bindGroup, binding.offsets);
      if (indirect) pass.dispatchWorkgroupsIndirect(indirect.buffer, indirect.offset);
      else pass.dispatchWorkgroups(x as number, y ?? 1, z ?? 1);
    }, () => origin);
  }

  #context(state: ComputeState, method: string) { return { where: `${this.label}.${method}`, dependencies: [state.shaderModule, state.pipelineLayout] }; }

  /** The GPU reads the workgroup counts from the buffer, so explicit counts alongside indirect are dead options and throw. */
  #resolveIndirectDispatch(state: ComputeState, opts: DispatchOptions, y?: number, z?: number): { readonly buffer: GPUBuffer; readonly offset: number } {
    const where = `${this.label}.dispatch`;
    if (y !== undefined || z !== undefined) throw indirectInvalidError(this.label, `indirect cannot be combined with explicit workgroup counts in the same call; the GPU reads the counts from the buffer, so the CPU-side values would be ignored.`, where);
    return resolveIndirect(this.label, where, opts.indirect, "dispatchWorkgroupsIndirect", state.device);
  }

  #preflightAliasing(state: ComputeState): void {
    if (!state.storageBindings.length) return;
    const buckets = new Map<GPUBuffer, { writable: boolean }[]>();
    for (const binding of state.storageBindings) {
      const bindingState = state.setCore.bindingState(binding.name);
      if (!bindingState) continue;
      const buffer = bindingState.underlyingBuffer;
      if (!buffer) continue;
      if (!buckets.has(buffer)) buckets.set(buffer, []);
      buckets.get(buffer)!.push({ writable: binding.access !== "read" });
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      if (!bucket.some((entry) => entry.writable)) continue;
      throw writableStorageAliasingError(`${this.label}.dispatch`);
    }
  }
}

function computeStateRecord(pipeline: ComputePipeline): ComputeState | ComputeTombstone {
  const state = computeStates.get(pipeline);
  if (!state) throw new TypeError("Invalid Compute instance");
  return state;
}

function computeState(pipeline: ComputePipeline, operation: string): ComputeState {
  const state = computeStateRecord(pipeline);
  if ("disposed" in state) throw computeDisposedError(state.label, operation);
  return state;
}

type ComputeWorkgroupValidation = {
  readonly label: string;
  readonly entryPoint: string;
  readonly size?: readonly number[];
  readonly limits: {
    readonly maxComputeWorkgroupSizeX: number;
    readonly maxComputeWorkgroupSizeY: number;
    readonly maxComputeWorkgroupSizeZ: number;
    readonly maxComputeInvocationsPerWorkgroup: number;
  };
};

function computeWorkgroupValidation(label: string, state: ComputeState): ComputeWorkgroupValidation {
  const limits = state.device.limits;
  return {
    label,
    entryPoint: state.entryPoint,
    size: state.entry.workgroupSize ? [...state.entry.workgroupSize] : undefined,
    limits: {
      maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ: limits.maxComputeWorkgroupSizeZ,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
    },
  };
}

function validateComputeWorkgroup(validation: ComputeWorkgroupValidation): void {
  validateComputeWorkgroupValues(validation.label, validation.entryPoint, validation.size, validation.limits);
}

function validateComputeWorkgroupState(label: string, state: ComputeState): void {
  validateComputeWorkgroupValues(label, state.entryPoint, state.entry.workgroupSize, state.device.limits);
}

function validateComputeWorkgroupValues(
  label: string,
  entryPoint: string,
  size: readonly number[] | undefined,
  limits: ComputeWorkgroupValidation["limits"],
): void {
  if (!size || !size.every(Number.isFinite)) return; // overrides/expressions remain native validation's responsibility
  const checks = [
    ["maxComputeWorkgroupSizeX", size[0], limits.maxComputeWorkgroupSizeX],
    ["maxComputeWorkgroupSizeY", size[1], limits.maxComputeWorkgroupSizeY],
    ["maxComputeWorkgroupSizeZ", size[2], limits.maxComputeWorkgroupSizeZ],
    ["maxComputeInvocationsPerWorkgroup", size[0]! * size[1]! * size[2]!, limits.maxComputeInvocationsPerWorkgroup],
  ] as const;
  for (const [name, value, limit] of checks) if (!Number.isInteger(value) || value < 1 || value > limit) {
    throw new VGPUError({ code: "VGPU-COMPUTE-WORKGROUP-INVALID", message: `Compute workgroup requires ${value} for ${name}; granted limit is ${limit}.`, where: `${label}.compile`, detail: { label, entry: entryPoint, workgroupSize: [...size], limitName: name, limit }, fix: `Reduce @workgroup_size or request a supported ${name} using init({ requiredLimits: ... }).` });
  }
}

function computeEntryPoint(reflection: Reflection, label: string, name?: string): EntryPointInfo {
  // A named entry validates existence and stage inside selectEntryPoint (VGPU-ENTRY-INVALID); only the
  // no-name case can come back undefined, keeping today's error for a shader without any @compute entry.
  const entry = selectEntryPoint(label, reflection.entryPoints, "compute", name, "compute");
  if (!entry) throw unsupportedError(`${label}.compute`, "The compute shader requires a @compute entry point.");
  return entry;
}
