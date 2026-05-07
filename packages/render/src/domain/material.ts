import type { Device, Shader } from "@vgpu/core";
import { PBR_SHADER_SOURCE, UNIFORMS_BYTE_SIZE, VERTEX_BUFFER_LAYOUT } from "./pbr-shader.ts";
import { pbrUniformBytes, type PbrUniformValues } from "./pbr-uniforms.ts";
import type { Vec3 } from "./camera.ts";

export interface MaterialParams {
  readonly baseColor: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
}

export interface DirectionalLight {
  readonly direction: Vec3 | readonly [number, number, number];
  readonly color: Vec3 | readonly [number, number, number];
  readonly intensity: number;
}

export type MaterialUniformValue = number | readonly number[] | Float32Array | Uint32Array | Int32Array | DirectionalLight;
export type MaterialWriteUniforms<T> = { bivarianceHack(values: T): void }["bivarianceHack"];

export interface MaterialGpu {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup?: GPUBindGroup;
  readonly uniformBuffer?: GPUBuffer;
}

export interface Material {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup?: GPUBindGroup;
  readonly shader: Shader;
  readonly uniformByteSize: number;
  readonly uniformOffsets?: Readonly<Record<string, number>>;
  readonly params: MaterialParams;
  readonly gpu?: MaterialGpu;
  readonly dispose?: () => void;
}

export interface PbrMaterial extends Material {
  readonly bindGroup: GPUBindGroup;
  readonly gpu: MaterialGpu & { readonly bindGroup: GPUBindGroup; readonly uniformBuffer: GPUBuffer };
  readonly writeUniforms: MaterialWriteUniforms<PbrUniformValues>;
}

export interface PbrMaterialSpec {
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
const cache = new WeakMap<Device, Map<string, PbrMaterial>>();

// Uniform byte layout is defined in ./pbr-shader.ts (see UNIFORM_OFFSET_*).

export function pbrMaterial(spec: PbrMaterialSpec): PbrMaterial {
  const metallic = spec.metallic ?? DEFAULT_METALLIC;
  const roughness = spec.roughness ?? DEFAULT_ROUGHNESS;
  const targetFormat = spec.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const key = materialKey(spec.baseColor, metallic, roughness, targetFormat);
  let materials = cache.get(spec.device);
  if (!materials) {
    materials = new Map<string, PbrMaterial>();
    cache.set(spec.device, materials);
  }
  const cached = materials.get(key);
  if (cached) return cached;

  const shader = spec.device.createShader(PBR_SHADER_SOURCE);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "pbrMaterial.bgl",
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: UNIFORMS_BYTE_SIZE } }],
  });
  const [red, green, blue] = spec.baseColor;
  const pipeline = spec.device.gpu.createRenderPipeline({
    label: `pbrMaterial(metallic=${metallic},roughness=${roughness},color=[${red},${green},${blue}])`,
    layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_BUFFER_LAYOUT] },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
    primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });

  const uniformBuffer = spec.device.createBuffer({
    label: "pbrMaterial.uniforms",
    size: UNIFORMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst", "copy_src"],
  });
  const bindGroup = spec.device.gpu.createBindGroup({
    label: "pbrMaterial.bindGroup",
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer.gpu, size: UNIFORMS_BYTE_SIZE } }],
  });
  const params = { baseColor: [red, green, blue] as readonly [number, number, number], metallic, roughness };
  const gpu = Object.freeze({ pipeline, bindGroup, uniformBuffer: uniformBuffer.gpu });
  const writeUniforms = (values: PbrUniformValues): void => {
    spec.device.gpu.queue.writeBuffer(uniformBuffer.gpu, 0, pbrUniformBytes(values, params));
  };
  const material = Object.freeze({
    pipeline, bindGroupLayout, bindGroup, shader, uniformByteSize: UNIFORMS_BYTE_SIZE, params, gpu, writeUniforms,
    dispose: () => uniformBuffer.destroy(),
  });
  materials.set(key, material);
  return material;
}

function materialKey(
  color: readonly [number, number, number],
  metallic: number,
  roughness: number,
  targetFormat: GPUTextureFormat,
): string {
  return `${format(color[0])},${format(color[1])},${format(color[2])};${format(metallic)};${format(roughness)};${targetFormat}`;
}

function format(value: number): string {
  return value.toFixed(6);
}

function shaderVisibility(): GPUShaderStageFlags {
  const stage = globalThis.GPUShaderStage as Record<"VERTEX" | "FRAGMENT", number> | undefined;
  return ((stage?.VERTEX ?? 1) | (stage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;
}
