import { PNG } from "pngjs";
import type { Device } from "@vgpu/core";
import type { Camera, Mat4, Mesh, Vec3 } from "@vgpu/render";
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
type Point3 = readonly [number, number, number];
const BOX_ATTRIBUTES = Object.freeze({
  stride: 24,
  position: Object.freeze({ offset: 0, format: "float32x3" as const }),
  normal: Object.freeze({ offset: 12, format: "float32x3" as const }),
});

export function createReadableBoxMesh(device: Device, size = 1): Mesh {
  const vertices = boxVertices(size);
  const vertexBuffer = device.createBuffer({
    label: `inspect.readable-box.size=${size}`,
    size: vertices.byteLength,
    usage: ["vertex", "copy_dst", "copy_src"],
  });
  vertexBuffer.write(vertices);
  const h = size / 2;
  return Object.freeze({
    vertexBuffer,
    vertexCount: 36,
    attributes: BOX_ATTRIBUTES,
    bbox: Object.freeze({
      min: new Float32Array([-h, -h, -h]) as Vec3,
      max: new Float32Array([h, h, h]) as Vec3,
    }),
  });
}

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

function boxVertices(size: number): Float32Array<ArrayBuffer> {
  const h = size / 2;
  const data: number[] = [];
  pushFace(data, [h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h], [1, 0, 0]);
  pushFace(data, [-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h], [-1, 0, 0]);
  pushFace(data, [-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h], [0, 1, 0]);
  pushFace(data, [-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h], [0, -1, 0]);
  pushFace(data, [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]);
  pushFace(data, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
  return new Float32Array(data);
}

function pushFace(data: number[], a: Point3, b: Point3, c: Point3, d: Point3, normal: Point3): void {
  pushVertex(data, a, normal);
  pushVertex(data, b, normal);
  pushVertex(data, c, normal);
  pushVertex(data, a, normal);
  pushVertex(data, c, normal);
  pushVertex(data, d, normal);
}

function pushVertex(data: number[], position: Point3, normal: Point3): void {
  data.push(position[0], position[1], position[2], normal[0], normal[1], normal[2]);
}
