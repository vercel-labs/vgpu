import type { Device, Texture } from "@vgpu/core";
import type { Material, Mesh } from "./domain/index.ts";
import { invalidUsage } from "./uniform-pool-internals.ts";

const textureBrand = Symbol.for("vgpu/Texture");

export interface DrawSpec {
  readonly pipeline?: GPURenderPipeline;
  readonly target: GPUTextureView | Texture;
  readonly vertexCount?: number;
  readonly clearValue?: GPUColor;
  readonly material: Material;
  readonly mesh?: Mesh;
  readonly depthTarget?: GPUTextureView | Texture;
}

/**
 * @deprecated Use `gpu.draw({ shader, mesh })`, `gpu.pass()`, and `gpu.frame()` from the ring-1 `vgpu` entrypoint. `RapidRenderer` is retained only for the old thick layer.
 */
export class RapidRenderer {
  constructor(private readonly device: Device) {}

  get gpu(): GPUDevice { return this.device.gpu; }

  async draw(spec: DrawSpec): Promise<void> {
    const pipeline = spec.pipeline ?? spec.material.pipeline;
    if (!pipeline) throw invalidUsage("RapidRenderer.draw", "DrawSpec.material requires Material.pipeline.");
    const vertexCount = spec.vertexCount ?? spec.mesh?.vertexCount;
    if (vertexCount === undefined) throw invalidUsage("RapidRenderer.draw", "DrawSpec.vertexCount is required when DrawSpec.mesh is absent.");

    const encoder = this.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: textureView(spec.target), loadOp: "clear", storeOp: "store", clearValue: colorTuple(spec.clearValue) }],
      depthStencilAttachment: spec.depthTarget ? { view: textureView(spec.depthTarget), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } : undefined,
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, spec.material.bindGroup ?? null);
    if (spec.mesh) bindMesh(pass, spec.mesh, vertexCount);
    else pass.draw(vertexCount, 1, 0, 0);
    pass.end();
    this.device.queue.gpu.submit([encoder.finish()]);
  }
}

function bindMesh(pass: GPURenderPassEncoder, mesh: Mesh, vertexCount: number): void {
  pass.setVertexBuffer(0, mesh.gpu?.vertexBuffer ?? mesh.vertexBuffer.gpu);
  if (mesh.indexBuffer !== undefined && mesh.indexCount !== undefined && mesh.indexFormat !== undefined) {
    pass.setIndexBuffer(mesh.gpu?.indexBuffer ?? mesh.indexBuffer.gpu, mesh.indexFormat);
    pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
    return;
  }
  pass.draw(vertexCount, 1, 0, 0);
}

function colorTuple(color: GPUColor | undefined): readonly [number, number, number, number] {
  if (!color) return [0, 0, 0, 1];
  if (isIterableColor(color)) {
    const values = Array.from(color);
    return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
  }
  return [color.r, color.g, color.b, color.a];
}

function isIterableColor(color: GPUColor): color is Iterable<number> {
  return Symbol.iterator in Object(color);
}

function textureView(view: Texture | GPUTextureView): GPUTextureView {
  return isVGPUTexture(view) ? view.createView() : view;
}

function isVGPUTexture(view: Texture | GPUTextureView): view is Texture {
  return Boolean((view as { readonly [textureBrand]?: true })[textureBrand]);
}
