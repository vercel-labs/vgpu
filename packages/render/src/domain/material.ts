import type { Device, Shader } from "@vgpu/core";
import { PBR_SHADER_SOURCE, UNIFORMS_BYTE_SIZE, VERTEX_BUFFER_LAYOUT } from "./pbr-shader.ts";

export interface MaterialParams {
  readonly baseColor: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
}

export interface Material {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly shader: Shader;
  readonly uniformByteSize: number;
  readonly params: MaterialParams;
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
const cache = new WeakMap<Device, Map<string, Material>>();

// Uniforms byte layout:
// 0 viewProjectionMatrix (64), 64 modelMatrix (64), 128 cameraPosition (12 + 4 pad),
// 144 lightDirection (12 + 4 pad), 160 lightColor (12), 172 lightIntensity (4),
// 176 explicit pad (12), 192 baseColor (12), 204 metallic (4), 208 roughness (4),
// 212 trailing pad (12), total 224 bytes.
export { UNIFORMS_BYTE_SIZE };

export function pbrMaterial(spec: PbrMaterialSpec): Material {
  const metallic = spec.metallic ?? DEFAULT_METALLIC;
  const roughness = spec.roughness ?? DEFAULT_ROUGHNESS;
  const targetFormat = spec.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const key = materialKey(spec.baseColor, metallic, roughness, targetFormat);
  let materials = cache.get(spec.device);
  if (!materials) {
    materials = new Map<string, Material>();
    cache.set(spec.device, materials);
  }
  const cached = materials.get(key);
  if (cached) return cached;

  const shader = spec.device.createShader(PBR_SHADER_SOURCE);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "pbrMaterial.bgl",
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORMS_BYTE_SIZE } }],
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

  const params = { baseColor: [red, green, blue] as readonly [number, number, number], metallic, roughness };
  const material = Object.freeze({ pipeline, bindGroupLayout, shader, uniformByteSize: UNIFORMS_BYTE_SIZE, params });
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
