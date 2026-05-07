import type { Device } from "@vgpu/core";
import { invalidUsage } from "../../../src/uniform-pool-internals.ts";
import type { Mat4, Vec3 } from "../../../src/domain/camera.ts";
import type { Material, MaterialGpu, MaterialParams, MaterialWriteUniforms } from "../../../src/domain/material.ts";
import {
  LIT_SHADER_SOURCE,
  UNIFORM_OFFSET_BASE_COLOR,
  UNIFORM_OFFSET_CAMERA_POSITION,
  UNIFORM_OFFSET_LIGHT_COLOR,
  UNIFORM_OFFSET_LIGHT_DIRECTION,
  UNIFORM_OFFSET_LIGHT_INTENSITY,
  UNIFORM_OFFSET_METALLIC,
  UNIFORM_OFFSET_MODEL,
  UNIFORM_OFFSET_ROUGHNESS,
  UNIFORM_OFFSET_VIEW_PROJECTION,
  VERTEX_BUFFER_LAYOUT,
  litUniformsByteSize,
} from "./lit-shader.ts";

export interface DirectionalLight {
  readonly direction: Vec3 | readonly [number, number, number];
  readonly color: Vec3 | readonly [number, number, number];
  readonly intensity: number;
}

export interface LitUniformValues {
  readonly viewProjection: Mat4;
  readonly model: Mat4;
  readonly cameraPosition: Vec3 | readonly [number, number, number];
  readonly light: DirectionalLight;
  readonly baseColor?: readonly [number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
}

export interface LitMaterial extends Material {
  readonly bindGroup: GPUBindGroup;
  readonly gpu: MaterialGpu & { readonly bindGroup: GPUBindGroup; readonly uniformBuffer: GPUBuffer };
  readonly writeUniforms: MaterialWriteUniforms<LitUniformValues>;
}

export interface LitMaterialSpec {
  readonly device: Device;
  /** Linear RGB. Use srgb(0xRRGGBB) to convert from sRGB color picks. */
  readonly baseColor: readonly [number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  readonly targetFormat?: GPUTextureFormat;
}

const DEFAULT_METALLIC = 0;
const DEFAULT_ROUGHNESS = 0.5;
const DEFAULT_TARGET_FORMAT = "bgra8unorm-srgb";
const cache = new WeakMap<Device, Map<string, LitMaterial>>();
const VIEW_PROJ = UNIFORM_OFFSET_VIEW_PROJECTION / Float32Array.BYTES_PER_ELEMENT;
const MODEL = UNIFORM_OFFSET_MODEL / Float32Array.BYTES_PER_ELEMENT;
const CAMERA = UNIFORM_OFFSET_CAMERA_POSITION / Float32Array.BYTES_PER_ELEMENT;
const LIGHT_DIRECTION = UNIFORM_OFFSET_LIGHT_DIRECTION / Float32Array.BYTES_PER_ELEMENT;
const LIGHT_COLOR = UNIFORM_OFFSET_LIGHT_COLOR / Float32Array.BYTES_PER_ELEMENT;
const LIGHT_INTENSITY = UNIFORM_OFFSET_LIGHT_INTENSITY / Float32Array.BYTES_PER_ELEMENT;
const BASE_COLOR = UNIFORM_OFFSET_BASE_COLOR / Float32Array.BYTES_PER_ELEMENT;
const METALLIC = UNIFORM_OFFSET_METALLIC / Float32Array.BYTES_PER_ELEMENT;
const ROUGHNESS = UNIFORM_OFFSET_ROUGHNESS / Float32Array.BYTES_PER_ELEMENT;
const REQUIRED = ["viewProjection", "model", "cameraPosition", "light"] as const;
const OPTIONAL = new Set(["baseColor", "metallic", "roughness"]);

export function litMaterial(spec: LitMaterialSpec): LitMaterial {
  const metallic = spec.metallic ?? DEFAULT_METALLIC;
  const roughness = spec.roughness ?? DEFAULT_ROUGHNESS;
  const targetFormat = spec.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const key = materialKey(spec.baseColor, metallic, roughness, targetFormat);
  let materials = cache.get(spec.device);
  if (!materials) { materials = new Map<string, LitMaterial>(); cache.set(spec.device, materials); }
  const cached = materials.get(key);
  if (cached) return cached;

  const shader = spec.device.createShader(LIT_SHADER_SOURCE);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "litMaterial.bgl",
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: litUniformsByteSize } }],
  });
  const [red, green, blue] = spec.baseColor;
  const pipeline = spec.device.gpu.createRenderPipeline({
    label: `litMaterial(metallic=${metallic},roughness=${roughness},color=[${red},${green},${blue}])`,
    layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_BUFFER_LAYOUT] },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
    primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });

  const uniformBuffer = spec.device.createBuffer({ label: "litMaterial.uniforms", size: litUniformsByteSize, usage: ["uniform", "copy_dst", "copy_src"] });
  const bindGroup = spec.device.gpu.createBindGroup({
    label: "litMaterial.bindGroup", layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer.gpu, size: litUniformsByteSize } }],
  });
  const params = { baseColor: [red, green, blue] as readonly [number, number, number], metallic, roughness };
  const gpu = Object.freeze({ pipeline, bindGroup, uniformBuffer: uniformBuffer.gpu });
  const writeUniforms = (values: LitUniformValues): void => spec.device.gpu.queue.writeBuffer(uniformBuffer.gpu, 0, litUniformBytes(values, params));
  const material = Object.freeze({
    pipeline, bindGroupLayout, bindGroup, shader, uniformByteSize: litUniformsByteSize, params, gpu, writeUniforms,
    dispose: () => uniformBuffer.destroy(),
  });
  materials.set(key, material);
  return material;
}

function litUniformBytes(uniforms: LitUniformValues, params: MaterialParams): Float32Array<ArrayBuffer> {
  validate(uniforms);
  const light = uniforms.light;
  const out = new Float32Array(litUniformsByteSize / Float32Array.BYTES_PER_ELEMENT);
  out.set(uniforms.viewProjection, VIEW_PROJ);
  out.set(uniforms.model, MODEL);
  write3(out, CAMERA, uniforms.cameraPosition);
  writeNormalized3(out, LIGHT_DIRECTION, light.direction);
  write3(out, LIGHT_COLOR, light.color);
  out[LIGHT_INTENSITY] = light.intensity;
  write3(out, BASE_COLOR, uniforms.baseColor ?? params.baseColor);
  out[METALLIC] = uniforms.metallic ?? params.metallic;
  out[ROUGHNESS] = uniforms.roughness ?? params.roughness;
  return out;
}

function validate(values: LitUniformValues): void {
  const keys = new Set(Object.keys(values));
  for (const key of REQUIRED) if (!keys.delete(key)) throw invalidUsage("litMaterial.writeUniforms", `Missing uniform '${key}'.`);
  for (const key of [...keys]) if (OPTIONAL.has(key)) keys.delete(key);
  const extra = keys.values().next().value as string | undefined;
  if (extra) throw invalidUsage("litMaterial.writeUniforms", `Unknown uniform '${extra}'.`);
}

function materialKey(color: readonly [number, number, number], metallic: number, roughness: number, targetFormat: GPUTextureFormat): string {
  return `${format(color[0])},${format(color[1])},${format(color[2])};${format(metallic)};${format(roughness)};${targetFormat}`;
}

function format(value: number): string { return value.toFixed(6); }
function write3(out: Float32Array, offset: number, value: Vec3 | readonly [number, number, number]): void { out[offset] = value[0]; out[offset + 1] = value[1]; out[offset + 2] = value[2]; }
function writeNormalized3(out: Float32Array, offset: number, value: Vec3 | readonly [number, number, number]): void {
  const x = value[0], y = value[1], z = value[2], length = Math.hypot(x, y, z) || 1;
  out[offset] = x / length; out[offset + 1] = y / length; out[offset + 2] = z / length;
}
function shaderVisibility(): GPUShaderStageFlags {
  const stage = globalThis.GPUShaderStage as Record<"VERTEX" | "FRAGMENT", number> | undefined;
  return ((stage?.VERTEX ?? 1) | (stage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;
}
