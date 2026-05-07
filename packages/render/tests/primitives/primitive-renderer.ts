import { PNG } from "pngjs";
import type { Device } from "@vgpu/core";
import { material, type Camera, type Mat4, type MeshPrimitive, type VertexLayoutKind } from "@vgpu/render";

export type PrimitiveMaterialVariant = "pbr" | "normalDebug32";

export interface RenderPrimitiveFrameSpec {
  readonly device: Device;
  readonly mesh: MeshPrimitive;
  readonly camera: Camera;
  readonly material: PrimitiveMaterialVariant;
  readonly baseColor?: readonly [number, number, number];
  readonly modelMatrix?: Mat4;
}

const WIDTH = 256;
const HEIGHT = 256;
const TARGET_FORMAT = "rgba8unorm-srgb";
const CLEAR_VALUE = { r: 63 / 255, g: 63 / 255, b: 80 / 255, a: 1 };
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4;
const FRAGMENT = `
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  if (uniforms.materialKind == 1u) {
    return vec4f(normal * 0.5 + 0.5, 1.0);
  }
  let light = normalize(vec3f(0.4, 1.0, 0.6));
  let lit = max(dot(normal, light), 0.0) * 0.9 + 0.1;
  return vec4f(uniforms.baseColor.rgb * lit, uniforms.baseColor.a);
}`;

export async function renderPrimitiveFrame(spec: RenderPrimitiveFrameSpec): Promise<Uint8Array> {
  const mat = material({
    device: spec.device,
    vertex: vertexShader(layoutOf(spec.mesh)),
    fragment: FRAGMENT,
    uniforms: { viewProjectionMatrix: "mat4x4f", modelMatrix: "mat4x4f", baseColor: "vec4f", materialKind: "u32" },
    vertexLayout: layoutOf(spec.mesh),
    targetFormat: TARGET_FORMAT,
    depthFormat: "depth24plus",
  });
  const color = spec.device.createTexture({ size: [WIDTH, HEIGHT], format: TARGET_FORMAT, usage: ["render_attachment", "copy_src"] });
  const depth = spec.device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus", usage: ["render_attachment"] });
  try {
    mat.writeUniforms({
      viewProjectionMatrix: spec.camera.viewProjectionMatrix,
      modelMatrix: spec.modelMatrix ?? IDENTITY,
      baseColor: [...(spec.baseColor ?? [0.7, 0.55, 0.45]), 1],
      materialKind: spec.material === "normalDebug32" ? 1 : 0,
    });
    draw(spec, mat.pipeline, mat.bindGroup, color, depth);
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    png.data.set(await color.read());
    return PNG.sync.write(png);
  } finally {
    mat.dispose();
    depth.destroy();
    color.destroy();
  }
}

function draw(
  spec: RenderPrimitiveFrameSpec,
  pipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
  color: ReturnType<Device["createTexture"]>,
  depth: ReturnType<Device["createTexture"]>,
): void {
  const encoder = spec.device.gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: color.createView(), loadOp: "clear", storeOp: "store", clearValue: CLEAR_VALUE }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, spec.mesh.vertexBuffer.gpu);
  if (spec.mesh.indexBuffer) {
    pass.setIndexBuffer(spec.mesh.indexBuffer.gpu, spec.mesh.indexFormat ?? "uint16");
    pass.drawIndexed(spec.mesh.indexCount ?? 0, 1, 0, 0, 0);
  } else {
    pass.draw(spec.mesh.vertexCount, 1, 0, 0);
  }
  pass.end();
  spec.device.queue.gpu.submit([encoder.finish()]);
}

function layoutOf(mesh: MeshPrimitive): VertexLayoutKind {
  return mesh.layout === "position-normal" ? "position-normal" : "position-normal-uv";
}

function vertexShader(layout: VertexLayoutKind): string {
  const uv = layout === "position-normal-uv" ? "  @location(2) uv: vec2f," : "";
  const outUv = layout === "position-normal-uv" ? "input.uv" : "vec2f(0.0, 0.0)";
  return `
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
${uv}
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) uv: vec2f,
};
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  let worldPosition = uniforms.modelMatrix * vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.position = uniforms.viewProjectionMatrix * worldPosition;
  output.worldNormal = normalize((uniforms.modelMatrix * vec4f(input.normal, 0.0)).xyz);
  output.uv = ${outUv};
  return output;
}`;
}
