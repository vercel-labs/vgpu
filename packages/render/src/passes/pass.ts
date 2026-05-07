import { ValidationError, type Device, type Texture } from "@vgpu/core";
import type { Material } from "../domain/material.ts";
import type { Mesh } from "../domain/mesh.ts";
import type { ClearColor, PassSpec, PassTarget, RenderTarget } from "../render-target/types.ts";

const DEFAULT_CLEAR_COLOR = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

type MeshWithIndex = Mesh & {
  readonly indexBuffer?: { readonly gpu: GPUBuffer };
  readonly indexFormat?: GPUIndexFormat;
  readonly indexCount?: number;
};

type MaterialWithBindGroup = Material & { readonly bindGroup?: GPUBindGroup | null };

type DeviceCarrier = { readonly device?: Device };

/** Records and optionally submits one material+mesh draw into a pass target. */
export function pass(spec: PassSpec): void {
  void spec.bindings;
  const colorAttachments = colorAttachmentsFor(spec.target, spec);
  const depthStencilAttachment = depthAttachmentFor(spec.target, spec);
  const device = spec.encoder ? undefined : deviceFrom(spec.mesh);
  const encoder = spec.encoder ?? (device as Device).gpu.createCommandEncoder();
  const renderPass = encoder.beginRenderPass({ colorAttachments, depthStencilAttachment });

  if (spec.viewport) renderPass.setViewport(spec.viewport[0], spec.viewport[1], spec.viewport[2], spec.viewport[3], 0, 1);
  if (spec.scissor) renderPass.setScissorRect(spec.scissor[0], spec.scissor[1], spec.scissor[2], spec.scissor[3]);

  renderPass.setPipeline(spec.material.pipeline);
  renderPass.setBindGroup(0, (spec.material as MaterialWithBindGroup).bindGroup ?? null);
  renderPass.setVertexBuffer(0, spec.mesh.vertexBuffer.gpu);

  const mesh = spec.mesh as MeshWithIndex;
  if (mesh.indexBuffer && mesh.indexCount !== undefined) {
    renderPass.setIndexBuffer(mesh.indexBuffer.gpu, mesh.indexFormat ?? "uint32");
    renderPass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
  } else {
    renderPass.draw(spec.mesh.vertexCount, 1, 0, 0);
  }

  renderPass.end();
  if (device) device.queue.gpu.submit([encoder.finish()]);
}

function colorAttachmentsFor(target: PassTarget, spec: PassSpec): readonly GPURenderPassColorAttachment[] {
  const loadOp = spec.colorLoadOp ?? "clear";
  if (isRenderTarget(target)) {
    if (target.gpu.colorAttachments.length > 1 && target.sampleCount !== 1) throw invalidUsage("MRT pass targets do not support MSAA in v2.");
    const clearColors = clearColorsForRenderTarget(target, spec.clearColor);
    return target.gpu.colorAttachments.map((source, index) => {
      const attachment = { ...source };
      attachment.loadOp = spec.colorLoadOp ?? attachment.loadOp;
      attachment.clearValue = clearColors?.[index] === undefined ? attachment.clearValue : colorDict(clearColors[index]);
      return attachment;
    });
  }
  if (isPerAttachmentClear(spec.clearColor)) throw invalidUsage("per-attachment clearColor requires a multi-color RenderTarget target.");
  if (isTexture(target)) return [{ view: target.createView(), loadOp, storeOp: "store", clearValue: colorDict(spec.clearColor) }];
  if (isTextureView(target)) return [{ view: target, loadOp, storeOp: "store", clearValue: colorDict(spec.clearColor) }];
  throw invalidTarget();
}

function depthAttachmentFor(target: PassTarget, spec: PassSpec): GPURenderPassDepthStencilAttachment | undefined {
  if (spec.depthTarget) return depthAttachmentFrom(spec.depthTarget, spec);
  if (isRenderTarget(target) && target.gpu.depthStencilAttachment) {
    const attachment = { ...target.gpu.depthStencilAttachment };
    attachment.depthLoadOp = spec.depthLoadOp ?? attachment.depthLoadOp;
    attachment.depthClearValue = spec.depthClearValue ?? attachment.depthClearValue;
    return attachment;
  }
  return undefined;
}

function depthAttachmentFrom(target: Texture | GPUTextureView, spec: PassSpec): GPURenderPassDepthStencilAttachment {
  if (!isTexture(target) && !isTextureView(target)) throw invalidTarget();
  return {
    view: isTexture(target) ? target.createView() : target,
    depthLoadOp: spec.depthLoadOp ?? "clear",
    depthStoreOp: "store",
    depthClearValue: spec.depthClearValue ?? 1,
  };
}

function deviceFrom(mesh: Mesh): Device {
  const device = (mesh.vertexBuffer as unknown as DeviceCarrier).device;
  if (!device) throw invalidUsage("pass() requires a mesh created by @vgpu/core when spec.encoder is absent.");
  return device;
}

function isRenderTarget(value: unknown): value is RenderTarget {
  const gpu = (value as { gpu?: unknown } | undefined)?.gpu;
  return isObject(gpu) && "colorAttachments" in gpu;
}

function isTexture(value: unknown): value is Texture {
  return isObject(value) && !isRenderTarget(value) && "gpu" in value && typeof (value as { createView?: unknown }).createView === "function";
}

function isTextureView(value: unknown): value is GPUTextureView {
  return isObject(value) && !("gpu" in value) && typeof (value as { createView?: unknown }).createView !== "function";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clearColorsForRenderTarget(target: RenderTarget, color: PassSpec["clearColor"]): readonly (ClearColor | undefined)[] | undefined {
  if (color === undefined) return undefined;
  if (!isPerAttachmentClear(color)) return target.gpu.colorAttachments.map(() => color);
  if (color.length !== target.gpu.colorAttachments.length) {
    throw invalidUsage(`pass() clearColor array length ${color.length} must match RenderTarget color attachment count ${target.gpu.colorAttachments.length}.`);
  }
  return color;
}

function isPerAttachmentClear(color: PassSpec["clearColor"]): color is readonly (ClearColor | undefined)[] {
  return Array.isArray(color) && typeof color[0] !== "number";
}

function colorDict(color: ClearColor | undefined): GPUColorDict {
  if (!color) return DEFAULT_CLEAR_COLOR;
  if (Array.isArray(color)) return { r: color[0], g: color[1], b: color[2], a: color[3] };
  return color as GPUColorDict;
}

function invalidTarget(): ValidationError {
  return invalidUsage("pass() target must be a RenderTarget, Texture, or GPUTextureView.");
}

function invalidUsage(message: string): ValidationError {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where: "pass" });
}
