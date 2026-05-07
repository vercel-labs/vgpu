import type { Device } from "@vgpu/core";
import type { InspectMaterial, InspectMaterialUniformParams } from "./inspect-material.ts";
import { WIREFRAME_SHADER } from "./wireframe-shader.ts";

export interface WireframeMaterialSpec {
  readonly device: Device;
  readonly color?: readonly [number, number, number];
  readonly targetFormat?: GPUTextureFormat;
}

const DEFAULT_COLOR = [1, 1, 1] as const;
const DEFAULT_TARGET_FORMAT = "bgra8unorm-srgb";
const UNIFORM_BYTE_SIZE = 144;
const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
  ],
};

export function wireframeMaterial(spec: WireframeMaterialSpec): InspectMaterial {
  const color = spec.color ?? DEFAULT_COLOR;
  const targetFormat = spec.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const shader = spec.device.createShader(WIREFRAME_SHADER);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "wireframeMaterial.bgl",
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: UNIFORM_BYTE_SIZE } }],
  });
  const pipeline = spec.device.gpu.createRenderPipeline({
    label: `wireframeMaterial(color=[${color[0]},${color[1]},${color[2]}])`,
    layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_BUFFER_LAYOUT] },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
    primitive: { topology: "line-list", cullMode: "none", frontFace: "ccw" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });

  return Object.freeze({
    pipeline,
    bindGroupLayout,
    uniformByteSize: UNIFORM_BYTE_SIZE,
    writeUniforms(buffer: GPUBuffer, offset: number, params: InspectMaterialUniformParams): void {
      const out = new Float32Array(UNIFORM_BYTE_SIZE / Float32Array.BYTES_PER_ELEMENT);
      out.set(params.viewProjectionMatrix, 0);
      out.set(params.modelMatrix, 16);
      out.set(color, 32);
      spec.device.gpu.queue.writeBuffer(buffer, offset, out);
    },
  });
}

function shaderVisibility(): GPUShaderStageFlags {
  const stage = globalThis.GPUShaderStage as Record<"VERTEX" | "FRAGMENT", number> | undefined;
  return ((stage?.VERTEX ?? 1) | (stage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;
}
