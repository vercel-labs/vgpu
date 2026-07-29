import type { Buffer, Device } from "@vgpu/core";
import type { BindingInfo, HostShareableLayout } from "@vgpu/wgsl/reflect-source";
import type { SharedUniforms } from "./api-types.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel, ownResource } from "./live-kernel.ts";
import { BINDING_RESOURCE, type BindingResourceProvider } from "./draw-protocols.ts";
import type { NormalizedBindingResource } from "./set-resources.ts";
import { sharedUniformLayoutMismatchError, unsupportedError } from "./errors.ts";
import { writeLayoutValue } from "./set-packing.ts";
import { formatSharedUniformLayout, sharedUniformLayoutSignature } from "./uniforms-layout.ts";
import { assertBufferUsable } from "./lifecycle.ts";

interface SharedUniformLayoutState {
  readonly layout: HostShareableLayout & { readonly size: number };
  readonly layoutSignature: string;
  readonly layoutText: string;
  readonly sourceHint: string;
  readonly addressSpace: "uniform" | "storage";
  readonly bindingName: string;
}

/**
 * Values-first shared uniform/storage buffer. The WGSL layout is adopted lazily from
 * the first shader that binds this object, keeping the backing buffer identity stable.
 */
export class SharedUniformsImpl<T extends Record<string, unknown>> implements SharedUniforms<T>, BindingResourceProvider {
  readonly #values: Record<string, unknown>;
  #state?: SharedUniformLayoutState;
  #bufferRef?: Buffer;

  constructor(private readonly device: Device, initialValues: T) {
    this.#values = cloneRecord(initialValues);
  }

  get buffer(): Buffer | undefined { return this.#bufferRef; }
  get gpu(): GPUBuffer | undefined { return this.#bufferRef?.gpu; }
  get size(): number | undefined { return this.#state?.layout.size; }

  set(values: Partial<T>): void {
    mergeInto(this.#values, values as Record<string, unknown>);
    this.#writeCurrentValues();
  }

  /**
   * Adopts or validates the reflected binding layout, then returns a user-owned resource.
   *
   * Keyed by the nominal protocol symbol so `set-resources.ts` recognizes a shared uniforms block
   * without importing this module: binding a plain buffer must not link the layout machinery.
   */
  [BINDING_RESOURCE](binding: BindingInfo, sourceHint: string): NormalizedBindingResource {
    ensureBufferBinding(binding);
    const adopted = this.#ensureLayout(binding, sourceHint);
    const buffer = this.#requiredBuffer();
    assertBufferUsable(buffer, `${sourceHint}.set`);
    return {
      resource: { buffer: buffer.gpu, offset: 0, size: adopted.layout.size },
      identity: buffer.resourceIdentity,
      unsubscribe: (cb) => buffer.onDestroy(cb),
    };
  }

  #ensureLayout(binding: BindingInfo, sourceHint: string): SharedUniformLayoutState {
    const layout = staticBindingLayout(binding);
    const addressSpace = normalizeAddressSpace(binding.addressSpace);
    if (!this.#state) return this.#adoptLayout(binding, layout, addressSpace, sourceHint);
    this.#assertCompatibleLayout(binding, layout, addressSpace, sourceHint);
    return this.#state;
  }

  #adoptLayout(binding: BindingInfo, layout: HostShareableLayout & { readonly size: number }, addressSpace: "uniform" | "storage", sourceHint: string): SharedUniformLayoutState {
    this.#state = {
      layout,
      layoutSignature: sharedUniformLayoutSignature(layout),
      layoutText: formatSharedUniformLayout(layout),
      sourceHint,
      bindingName: binding.name,
      addressSpace,
    };
    this.#bufferRef = this.device.createBuffer({
      size: layout.size,
      usage: addressSpace === "storage" ? ["storage", "copy_dst"] : ["uniform", "copy_dst"],
      label: `${binding.name}.sharedUniform`,
    });
    this.#writeCurrentValues();
    return this.#state;
  }

  #assertCompatibleLayout(binding: BindingInfo, layout: HostShareableLayout, addressSpace: "uniform" | "storage", sourceHint: string): void {
    const state = this.#state!;
    if (state.addressSpace !== addressSpace) {
      throw unsupportedError("uniforms", `shared uniforms '${state.bindingName}' already adopted address space ${state.addressSpace}; '${binding.name}' uses ${addressSpace}.`);
    }
    if (sharedUniformLayoutSignature(layout) === state.layoutSignature) return;
    throw sharedUniformLayoutMismatchError({
      bindingName: state.bindingName,
      adoptedLayout: state.layoutText,
      adoptedSource: state.sourceHint,
      incomingLayout: formatSharedUniformLayout(layout, { abbreviated: true }),
      incomingSource: sourceHint,
    });
  }

  #writeCurrentValues(): void {
    if (!this.#state || !this.#bufferRef) return;
    this.#bufferRef.write(writeLayoutValue(this.#state.layout, this.#values), 0);
  }

  #requiredBuffer(): Buffer {
    if (!this.#bufferRef) throw unsupportedError("uniforms", "shared uniforms have not adopted a layout yet.");
    return this.#bufferRef;
  }

  /**
   * Frees the backing buffer, if the layout was already adopted. Idempotent, and a no-op for an
   * object that no shader ever bound — the buffer only exists after adoption.
   *
   * @internal Lifetime is the gpu's: `gpu.dispose()` runs this in the resource phase.
   */
  destroy(): void {
    this.#bufferRef?.destroy();
  }
}

export function createSharedUniforms<T extends Record<string, unknown>>(device: Device, values: T): SharedUniformsImpl<T> {
  return new SharedUniformsImpl(device, values);
}

/**
 * Values-first shared uniform/storage block for this gpu. Bind the same object in several shaders:
 * the WGSL layout is adopted from the first binding that uses it and validated against the rest, so
 * one `set()` updates every consumer through a single buffer.
 *
 * The buffer (created on adoption) is freed by `gpu.dispose()`.
 */
export function uniforms<T extends Record<string, unknown>>(gpu: Gpu, values: T): SharedUniforms<T> {
  const kernel = liveKernel(gpu, "uniforms");
  return ownResource(kernel, new SharedUniformsImpl(kernel.device, values), (shared) => shared.destroy());
}

function ensureBufferBinding(binding: BindingInfo): void {
  if (binding.bindingLayout?.kind === "buffer") return;
  throw unsupportedError("uniforms", `Binding '${binding.name}' does not accept shared uniforms; the shader reflected ${binding.bindingLayout?.kind ?? "none"}.`);
}

function staticBindingLayout(binding: BindingInfo): HostShareableLayout & { readonly size: number } {
  if (!binding.layout) throw unsupportedError("uniforms", `Binding '${binding.name}' does not expose a host-shareable layout.`);
  if (binding.layout.size === undefined) throw unsupportedError("uniforms", `Binding '${binding.name}' has a runtime-sized layout; it cannot be shared.`);
  return binding.layout as HostShareableLayout & { readonly size: number };
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key] as Record<string, unknown>, value);
    else target[key] = cloneValue(value);
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) next[key] = cloneValue(entry);
  return next;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (ArrayBuffer.isView(value)) return cloneTypedArray(value);
  if (isPlainObject(value)) return cloneRecord(value);
  return value;
}

function cloneTypedArray(value: ArrayBufferView): unknown {
  if (value instanceof Float32Array) return value.slice();
  if (value instanceof Uint32Array) return value.slice();
  if (value instanceof Int32Array) return value.slice();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function normalizeAddressSpace(addressSpace: BindingInfo["addressSpace"]): "uniform" | "storage" {
  return addressSpace === "storage" ? "storage" : "uniform";
}
