import { PNG } from "pngjs";
import type { Device } from "@vgpu/core";
import type { Camera, Mat4 } from "@vgpu/render";
import type { InspectMaterial } from "@vgpu/render/inspect";

export interface RenderInspectFrameSpec {
  readonly device: Device;
  readonly material: InspectMaterial;
  readonly vertexBuffer: GPUBuffer;
  readonly vertexCount: number;
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly indexCount?: number;
  readonly camera: Camera;
  readonly modelMatrix?: Mat4;
  readonly targetFormat?: GPUTextureFormat;
  readonly clearValue?: GPUColor;
}

const WIDTH = 256;
const HEIGHT = 256;
const DEFAULT_TARGET_FORMAT = "rgba8unorm-srgb";
const DEFAULT_CLEAR_VALUE = { r: 0.05, g: 0.05, b: 0.08, a: 1 };
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4;

export async function renderInspectFrame(spec: RenderInspectFrameSpec): Promise<Uint8Array> {
  const color = spec.device.createTexture({
    size: [WIDTH, HEIGHT],
    format: spec.targetFormat ?? DEFAULT_TARGET_FORMAT,
    usage: ["render_attachment", "copy_src"],
  });
  const depth = spec.device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus", usage: ["render_attachment"] });
  const uniformBuffer = spec.device.createBuffer({
    label: "renderInspectFrame.uniform",
    size: spec.material.uniformByteSize,
    usage: ["uniform", "copy_dst"],
  });
  try {
    const bindGroup = spec.device.gpu.createBindGroup({
      label: "renderInspectFrame.bindGroup",
      layout: spec.material.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer.gpu } }],
    });
    spec.material.writeUniforms(uniformBuffer.gpu, 0, {
      viewProjectionMatrix: spec.camera.viewProjectionMatrix,
      modelMatrix: spec.modelMatrix ?? IDENTITY,
    });

    const encoder = spec.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: color.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: spec.clearValue ?? DEFAULT_CLEAR_VALUE,
      }],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(spec.material.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, spec.vertexBuffer);
    if (spec.indexBuffer) {
      pass.setIndexBuffer(spec.indexBuffer, spec.indexFormat ?? "uint16");
      pass.drawIndexed(spec.indexCount ?? 0, 1, 0, 0, 0);
    } else {
      pass.draw(spec.vertexCount, 1, 0, 0);
    }
    pass.end();
    spec.device.queue.gpu.submit([encoder.finish()]);

    const png = new PNG({ width: WIDTH, height: HEIGHT });
    png.data.set(await color.read());
    return PNG.sync.write(png);
  } finally {
    uniformBuffer.destroy();
    depth.destroy();
    color.destroy();
  }
}
