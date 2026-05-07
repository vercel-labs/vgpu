import type { Device } from "@vgpu/core";
import type { InspectMaterial, InspectMaterialUniformParams } from "@vgpu/render/inspect";

export interface WireframeOverlayMaterialSpec {
  readonly device: Device;
  readonly targetFormat?: GPUTextureFormat;
  readonly color?: readonly [number, number, number];
}

const DEFAULT_TARGET_FORMAT = "rgba8unorm-srgb";
const DEFAULT_COLOR = [1, 1, 1] as const;
const UNIFORM_BYTE_SIZE = 144;
const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
  ],
};

export function wireframeOverlayMaterial(spec: WireframeOverlayMaterialSpec): InspectMaterial {
  const color = spec.color ?? DEFAULT_COLOR;
  const shader = spec.device.createShader(shaderSource());
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "edit.wireframeOverlayMaterial.bgl",
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: UNIFORM_BYTE_SIZE } }],
  });
  const pipeline = spec.device.gpu.createRenderPipeline({
    label: "edit.wireframeOverlayMaterial",
    layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_BUFFER_LAYOUT] },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: spec.targetFormat ?? DEFAULT_TARGET_FORMAT }] },
    primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
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

function shaderSource(): string {
  return /* wgsl */ `
struct Uniforms {
  viewProjection: mat4x4<f32>,
  model: mat4x4<f32>,
  color: vec3<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(vertex_index) vertexIndex: u32,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) barycentric: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = u.viewProjection * u.model * vec4<f32>(input.position, 1.0);
  let corner = input.vertexIndex % 3u;
  if (corner == 0u) { output.barycentric = vec3<f32>(1.0, 0.0, 0.0); }
  else if (corner == 1u) { output.barycentric = vec3<f32>(0.0, 1.0, 0.0); }
  else { output.barycentric = vec3<f32>(0.0, 0.0, 1.0); }
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let edgeDistance = min(input.barycentric.x, min(input.barycentric.y, input.barycentric.z));
  if (edgeDistance > 0.035) { discard; }
  return vec4<f32>(u.color, 1.0);
}
`;
}

function shaderVisibility(): GPUShaderStageFlags {
  const stage = globalThis.GPUShaderStage as Record<"VERTEX" | "FRAGMENT", number> | undefined;
  return ((stage?.VERTEX ?? 1) | (stage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;
}
