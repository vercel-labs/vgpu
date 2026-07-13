import type { Buffer, Device } from "@vgpu/core";
import type { BindingInfo, HostShareableLayout, LayoutMember, WGSLType } from "@vgpu/wgsl/runtime";
import type { SharedUniforms } from "./gpu.ts";
import type { NormalizedBindingResource } from "./set-resources.ts";
import { sharedUniformLayoutMismatchError, unsupportedError } from "./errors.ts";
import { writeLayoutValue } from "./set-packing.ts";

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
export class SharedUniformsImpl<T extends Record<string, unknown>> implements SharedUniforms<T> {
  private readonly values: Record<string, unknown>;
  private state?: SharedUniformLayoutState;
  private bufferRef?: Buffer;

  constructor(private readonly device: Device, initialValues: T) {
    this.values = cloneRecord(initialValues);
  }

  get buffer(): Buffer | undefined { return this.bufferRef; }
  get gpu(): GPUBuffer | undefined { return this.bufferRef?.gpu; }
  get size(): number | undefined { return this.state?.layout.size; }

  set(values: Partial<T>): void {
    mergeInto(this.values, values as Record<string, unknown>);
    this.writeCurrentValues();
  }

  /** Adopts or validates the reflected binding layout, then returns a user-owned resource. */
  asBindingResource(binding: BindingInfo): NormalizedBindingResource {
    ensureBufferBinding(binding);
    const adopted = this.ensureLayout(binding);
    const buffer = this.requiredBuffer();
    return {
      resource: { buffer: buffer.gpu, offset: 0, size: adopted.layout.size },
      identity: buffer.resourceIdentity,
      unsubscribe: (cb) => buffer.onDestroy(cb),
    };
  }

  private ensureLayout(binding: BindingInfo): SharedUniformLayoutState {
    const layout = staticBindingLayout(binding);
    const addressSpace = normalizeAddressSpace(binding.addressSpace);
    if (!this.state) return this.adoptLayout(binding, layout, addressSpace);
    this.assertCompatibleLayout(binding, layout, addressSpace);
    return this.state;
  }

  private adoptLayout(binding: BindingInfo, layout: HostShareableLayout & { readonly size: number }, addressSpace: "uniform" | "storage"): SharedUniformLayoutState {
    this.state = {
      layout,
      layoutSignature: layoutSignature(layout),
      layoutText: formatLayout(layout),
      sourceHint: bindingSourceHint(binding),
      bindingName: binding.name,
      addressSpace,
    };
    this.bufferRef = this.device.createBuffer({
      size: layout.size,
      usage: addressSpace === "storage" ? ["storage", "copy_dst"] : ["uniform", "copy_dst"],
      label: `${binding.name}.sharedUniform`,
    });
    this.writeCurrentValues();
    return this.state;
  }

  private assertCompatibleLayout(binding: BindingInfo, layout: HostShareableLayout, addressSpace: "uniform" | "storage"): void {
    const state = this.state!;
    if (state.addressSpace !== addressSpace) {
      throw unsupportedError("gpu.uniforms", `shared uniforms '${state.bindingName}' ya adoptó address space ${state.addressSpace}; '${binding.name}' usa ${addressSpace}.`);
    }
    if (layoutSignature(layout) === state.layoutSignature) return;
    throw sharedUniformLayoutMismatchError({
      bindingName: state.bindingName,
      adoptedLayout: state.layoutText,
      adoptedSource: state.sourceHint,
      incomingLayout: formatLayout(layout),
      incomingSource: bindingSourceHint(binding),
    });
  }

  private writeCurrentValues(): void {
    if (!this.state || !this.bufferRef) return;
    this.bufferRef.write(writeLayoutValue(this.state.layout, this.values), 0);
  }

  private requiredBuffer(): Buffer {
    if (!this.bufferRef) throw unsupportedError("gpu.uniforms", "shared uniforms todavía no adoptó layout.");
    return this.bufferRef;
  }
}

export function createSharedUniforms<T extends Record<string, unknown>>(device: Device, values: T): SharedUniformsImpl<T> {
  return new SharedUniformsImpl(device, values);
}

export function isSharedUniformsValue(value: unknown): value is SharedUniformsImpl<Record<string, unknown>> {
  return value instanceof SharedUniformsImpl;
}

function ensureBufferBinding(binding: BindingInfo): void {
  if (binding.bindingLayout?.kind === "buffer") return;
  throw unsupportedError("gpu.uniforms", `Binding '${binding.name}' no acepta shared uniforms; el shader reflejó ${binding.bindingLayout?.kind ?? "ninguno"}.`);
}

function staticBindingLayout(binding: BindingInfo): HostShareableLayout & { readonly size: number } {
  if (!binding.layout) throw unsupportedError("gpu.uniforms", `Binding '${binding.name}' no expone layout host-shareable.`);
  if (binding.layout.size === undefined) throw unsupportedError("gpu.uniforms", `Binding '${binding.name}' tiene un layout runtime-sized; no se puede compartir.`);
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

function bindingSourceHint(binding: BindingInfo): string {
  const source = sourceHintFromLabel(binding.mangledName);
  if (source) return source;
  return binding.name;
}

function sourceHintFromLabel(mangledName: string | undefined): string | undefined {
  if (!mangledName) return undefined;
  const match = /^_vgsl_([0-9a-f]{8})__/.exec(mangledName);
  if (!match) return undefined;
  return knownSourceHint(match[1]) ?? `${match[1]}_WGSL`;
}

function knownSourceHint(hash: string): string | undefined {
  return ({
    bef06fe6: "WAVE_WGSL",
    "2f73b440": "BLUR_WGSL",
    "1f4aaecd": "wave",
    a1fb97e9: "blur",
  } as Record<string, string>)[hash];
}

function layoutSignature(layout: HostShareableLayout): string {
  return JSON.stringify(signatureNode(layout));
}

function signatureNode(layout: HostShareableLayout): unknown {
  if (layout.members?.length) return layout.members.map((member) => [member.name, signatureNode(member.layout)]);
  if (layout.element) return { array: signatureNode(layout.element), count: arrayCount(layout.type) };
  return typeSignature(layout.type);
}

function typeSignature(type: WGSLType): unknown {
  switch (type.kind) {
    case "scalar": return { scalar: type.name };
    case "vector": return { vector: type.width, element: typeSignature(type.element) };
    case "matrix": return { matrix: [type.columns, type.rows], element: typeSignature(type.element) };
    case "array": return { array: typeSignature(type.element), count: type.count ?? type.countExpression };
    case "atomic": return { atomic: typeSignature(type.element) };
    default: return type.kind;
  }
}

function formatLayout(layout: HostShareableLayout): string {
  if (layout.members?.length) return `{ ${layout.members.map(formatMember).join(", ")} }`;
  if (layout.element) return formatArrayLayout(layout);
  return formatType(layout.type);
}

function formatArrayLayout(layout: HostShareableLayout): string {
  const count = arrayCount(layout.type);
  const suffix = count === undefined ? "" : `, ${count}`;
  return `array<${formatLayout(layout.element!)}${suffix}>`;
}

function formatMember(member: LayoutMember): string {
  return `${member.name}: ${formatLayout(member.layout)}`;
}

function formatType(type: WGSLType): string {
  switch (type.kind) {
    case "scalar": return type.name;
    case "vector": return `vec${type.width}${scalarSuffix(type.element)}`;
    case "matrix": return `mat${type.columns}x${type.rows}${scalarSuffix(type.element)}`;
    case "array": return formatArrayType(type);
    case "identifier": return type.name;
    case "atomic": return `atomic<${formatType(type.element)}>`;
    default: return type.kind;
  }
}

function formatArrayType(type: Extract<WGSLType, { readonly kind: "array" }>): string {
  const count = type.count ?? type.countExpression;
  const suffix = count === undefined ? "" : `, ${count}`;
  return `array<${formatType(type.element)}${suffix}>`;
}

function scalarSuffix(type: WGSLType): string {
  if (type.kind !== "scalar") return "";
  if (type.name === "bool") return "b";
  return type.name.slice(0, 1);
}

function arrayCount(type: WGSLType): string | number | undefined {
  return type.kind === "array" ? type.count ?? type.countExpression : undefined;
}
