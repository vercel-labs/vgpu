import { bind, Buffer, createBindGroup, createBindGroupLayout, ValidationError, type BindVisibility, type Device } from "@vgpu/core";
import {
  alignUniforms,
  isWgslUniformType,
  uniformValueCount,
  wgslType,
  writeUniformField,
  type UniformField,
  type UniformLayoutInfo,
  type WgslUniformType,
} from "./wgsl-alignment.ts";

export type ScalarUniformType = "f32" | "u32" | "i32";
export type VectorUniformInput = readonly number[] | Float32Array | Uint32Array | Int32Array;
export type UniformValues<S extends Record<string, WgslUniformType>> = {
  [K in keyof S]: S[K] extends ScalarUniformType ? number : VectorUniformInput;
};

export interface StructuredUniformOptions<S extends Record<string, WgslUniformType>> {
  /** Field insertion order = WGSL member order. Offsets come from alignUniforms. */
  readonly schema: S;
  readonly label?: string;
  /** Used only by the lazy bindGroupLayout getter. Default VERTEX | FRAGMENT. */
  readonly visibility?: BindVisibility;
}

export class StructuredUniform<S extends Record<string, WgslUniformType>> {
  readonly schema: S;
  readonly layout: UniformLayoutInfo;
  readonly byteSize: number;
  readonly offsets: Readonly<Record<keyof S, number>>;
  readonly buffer: Buffer;
  private readonly fieldsByName: ReadonlyMap<string, UniformField>;
  private readonly scratch: ArrayBuffer;
  private readonly view: DataView;
  private readonly label?: string;
  private readonly visibility?: BindVisibility;
  private lazyBindGroupLayout: GPUBindGroupLayout | undefined;
  private lazyBindGroup: GPUBindGroup | undefined;
  private destroyed = false;

  constructor(readonly device: Device, opts: StructuredUniformOptions<S>) {
    validateSchema(opts.schema);
    this.schema = opts.schema;
    this.layout = alignUniforms(opts.schema);
    this.byteSize = this.layout.byteSize;
    this.offsets = this.layout.offsets as Readonly<Record<keyof S, number>>;
    this.fieldsByName = new Map(this.layout.fields.map((field) => [field.name, field]));
    this.scratch = new ArrayBuffer(this.byteSize);
    this.view = new DataView(this.scratch);
    this.label = opts.label;
    this.visibility = opts.visibility;
    this.buffer = device.createBuffer({ size: this.byteSize, usage: ["uniform", "copy_dst"], label: opts.label });
  }

  get gpu(): GPUBuffer {
    return this.buffer.gpu;
  }

  get bindGroupLayout(): GPUBindGroupLayout {
    this.assertAlive("StructuredUniform.bindGroupLayout");
    this.lazyBindGroupLayout ??= createBindGroupLayout(this.device, {
      label: this.label ? `${this.label}.bgl` : undefined,
      entries: [bind.uniform(0, this.visibility ?? ["vertex", "fragment"], { minBindingSize: this.byteSize })],
    });
    return this.lazyBindGroupLayout;
  }

  get bindGroup(): GPUBindGroup {
    this.assertAlive("StructuredUniform.bindGroup");
    this.lazyBindGroup ??= createBindGroup(this.device, {
      label: this.label ? `${this.label}.bg` : undefined,
      layout: this.bindGroupLayout,
      entries: [bind.resource(0, this.buffer)],
    });
    return this.lazyBindGroup;
  }

  write(values: Partial<UniformValues<S>>): void {
    this.assertAlive("StructuredUniform.write");
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      const field = this.fieldsByName.get(name);
      if (!field) throw invalidUsage("StructuredUniform.write", `Unknown uniform '${name}'.`);
      if (isScalarUniformType(field.type) && typeof value !== "number") {
        throw invalidUsage("StructuredUniform.write", `Uniform '${field.name}' must be a number.`);
      }
      if (!isScalarUniformType(field.type) && !isVectorUniformInput(value)) {
        throw invalidUsage("StructuredUniform.write", `Uniform '${field.name}' must be an array, Float32Array, Uint32Array, or Int32Array.`);
      }
      writeUniformField(this.view, field, value, { exactLength: true, where: "StructuredUniform.write" });
    }
    this.device.gpu.queue.writeBuffer(this.gpu, 0, this.scratch);
  }

  wgsl(structName = "Uniforms"): string {
    const lines = this.layout.fields.map((field) => `  ${field.name}: ${wgslType(field.type)},`);
    return [`struct ${structName} {`, ...lines, `};`].join("\n");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.buffer.destroy();
  }

  dispose(): void {
    this.destroy();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }

  private assertAlive(where: string): void {
    if (!this.destroyed) return;
    throw invalidUsage(where, "StructuredUniform has been destroyed.");
  }
}

function isScalarUniformType(type: WgslUniformType): type is ScalarUniformType {
  return type === "f32" || type === "u32" || type === "i32";
}

function isVectorUniformInput(value: unknown): value is VectorUniformInput {
  return Array.isArray(value) || value instanceof Float32Array || value instanceof Uint32Array || value instanceof Int32Array;
}

function validateSchema(schema: Record<string, unknown>): void {
  const entries = Object.entries(schema);
  if (entries.length === 0) throw invalidUsage("StructuredUniform", "Uniform schema must not be empty.");
  for (const [name, type] of entries) {
    if (!isWgslUniformType(type)) throw invalidUsage("StructuredUniform", `Unsupported uniform type for '${name}'.`);
    if (uniformValueCount(type) < 1) throw invalidUsage("StructuredUniform", `Unsupported uniform type for '${name}'.`);
  }
}

function invalidUsage(where: string, message: string): ValidationError {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where });
}
