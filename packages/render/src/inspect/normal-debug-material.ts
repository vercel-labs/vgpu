import type { Device } from "@vgpu/core";
import type { InspectMaterial, InspectMaterialUniformParams } from "./inspect-material.ts";
import { NORMAL_DEBUG_SHADER } from "./normal-debug-shader.ts";

export interface NormalDebugMaterialSpec {
  readonly device: Device;
  readonly targetFormat?: GPUTextureFormat;
}

const DEFAULT_TARGET_FORMAT = "bgra8unorm-srgb";
const UNIFORM_BYTE_SIZE = 128;
const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
  ],
};

export function normalDebugMaterial(spec: NormalDebugMaterialSpec): InspectMaterial {
  const targetFormat = spec.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const shader = spec.device.createShader(NORMAL_DEBUG_SHADER);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "normalDebugMaterial.bgl",
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: UNIFORM_BYTE_SIZE } }],
  });
  const pipeline = spec.device.gpu.createRenderPipeline({
    label: "normalDebugMaterial",
    layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_BUFFER_LAYOUT] },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
    primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
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
      spec.device.gpu.queue.writeBuffer(buffer, offset, out);
    },
  });
}

function shaderVisibility(): GPUShaderStageFlags {
  const stage = globalThis.GPUShaderStage as Record<"VERTEX" | "FRAGMENT", number> | undefined;
  return ((stage?.VERTEX ?? 1) | (stage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;
}
