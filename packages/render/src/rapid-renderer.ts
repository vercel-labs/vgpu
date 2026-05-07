import type { Device } from "@vgpu/core";
import { RenderPass } from "./render-pass.ts";
import type { Camera, Material, Mat4, Mesh, Vec3 } from "./domain/index.ts";
import { UniformPool } from "./uniform-pool.ts";
import { invalidUsage } from "./uniform-pool-internals.ts";
import type { UniformLayout, UniformSlot } from "./uniform-pool-types.ts";

export interface DrawSpec {
  readonly pipeline?: GPURenderPipeline;
  readonly target: GPUTextureView;
  readonly vertexCount?: number;
  readonly clearValue?: GPUColor;
  readonly material?: Material;
  readonly mesh?: Mesh;
  readonly transform?: Mat4;
  readonly camera?: Camera;
  readonly light?: DirectionalLight;
  readonly depthTarget?: GPUTextureView;
}

export interface DirectionalLight {
  readonly direction: Vec3 | readonly [number, number, number];
  readonly color: Vec3 | readonly [number, number, number];
  readonly intensity: number;
}

const VIEW_PROJ = 0, MODEL = 16, CAMERA = 32, LIGHT_DIRECTION = 36, LIGHT_COLOR = 40;
const LIGHT_INTENSITY = 43, BASE_COLOR = 48, METALLIC = 51, ROUGHNESS = 52;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4;
const DEFAULT_LIGHT = { direction: [-0.4, -0.7, -0.6], color: [1, 1, 1], intensity: 1 } as DirectionalLight;

export class RapidRenderer {
  private pool: UniformPool | undefined;
  private readonly slotCache = new WeakMap<Material, UniformSlot<unknown>>();
  private frameIndex = 0;

  constructor(private readonly device: Device) {}

  get gpu(): GPUDevice { return this.device.gpu; }

  async draw(spec: DrawSpec): Promise<void> {
    if (spec.material) { this.drawMaterial(spec); return; }
    this.drawMinimum(spec);
  }

  private drawMinimum(spec: DrawSpec): void {
    if (!spec.pipeline) throw invalidUsage("RapidRenderer.draw", "DrawSpec.pipeline is required when DrawSpec.material is absent.");
    if (spec.vertexCount === undefined) throw invalidUsage("RapidRenderer.draw", "DrawSpec.vertexCount is required when DrawSpec.mesh is absent.");
    const pass = new RenderPass(this.device, { colorAttachments: [{ view: spec.target, loadOp: "clear", storeOp: "store", clearValue: colorTuple(spec.clearValue) }] });
    pass.setPipeline(spec.pipeline);
    pass.draw({ vertexCount: spec.vertexCount });
    pass.end();
  }

  private drawMaterial(spec: DrawSpec): void {
    const material = spec.material;
    if (!material) throw invalidUsage("RapidRenderer.draw", "DrawSpec.material is required.");
    if (!spec.mesh) throw invalidUsage("RapidRenderer.draw", "DrawSpec.material requires DrawSpec.mesh");
    if (!spec.camera) throw invalidUsage("RapidRenderer.draw", "DrawSpec.material requires DrawSpec.camera");
    if (!spec.depthTarget) throw invalidUsage("RapidRenderer.draw", "DrawSpec.material requires DrawSpec.depthTarget");
    if (!material.pipeline) throw invalidUsage("RapidRenderer.draw", "DrawSpec.material requires Material.pipeline");
    const pool = this.uniformPool();
    pool.beginFrame(this.frameIndex++);
    const slot = this.slotFor(material);
    const dynamicOffset = pool.pushBytes(slot, uniformBytes(spec.camera, spec.transform ?? IDENTITY, spec.light ?? DEFAULT_LIGHT, material));
    pool.endFrame();
    pool.assertReadyForSubmit("RapidRenderer.draw");
    const encoder = this.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: spec.target, loadOp: "clear", storeOp: "store", clearValue: colorTuple(spec.clearValue) }],
      depthStencilAttachment: { view: spec.depthTarget, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setPipeline(material.pipeline);
    pass.setBindGroup?.(0, slot.bindGroup, [dynamicOffset]);
    pass.setVertexBuffer?.(0, spec.mesh.vertexBuffer.gpu);
    pass.draw(spec.mesh.vertexCount, 1, 0, 0);
    pass.end();
    this.device.queue.gpu.submit([encoder.finish()]);
  }

  private uniformPool(): UniformPool {
    this.pool ??= new UniformPool(this.device);
    return this.pool;
  }

  private slotFor(material: Material): UniformSlot<unknown> {
    const cached = this.slotCache.get(material);
    if (cached) return cached;
    const slot = this.uniformPool().alloc(layoutFor(material));
    this.slotCache.set(material, slot);
    return slot;
  }
}

function layoutFor(material: Material): UniformLayout<unknown> {
  return { size: material.uniformByteSize, bindGroupLayout: material.bindGroupLayout, encode() {} };
}

function uniformBytes(camera: Camera, transform: Mat4, light: DirectionalLight, material: Material): Float32Array<ArrayBuffer> {
  const out = new Float32Array(material.uniformByteSize / Float32Array.BYTES_PER_ELEMENT);
  out.set(camera.viewProjectionMatrix, VIEW_PROJ); out.set(transform, MODEL); write3(out, CAMERA, camera.position);
  writeNormalized3(out, LIGHT_DIRECTION, light.direction); write3(out, LIGHT_COLOR, light.color); out[LIGHT_INTENSITY] = light.intensity;
  write3(out, BASE_COLOR, material.params.baseColor); out[METALLIC] = material.params.metallic; out[ROUGHNESS] = material.params.roughness;
  return out;
}

function write3(out: Float32Array, offset: number, value: Vec3 | readonly [number, number, number]): void {
  out[offset] = value[0]; out[offset + 1] = value[1]; out[offset + 2] = value[2];
}

function writeNormalized3(out: Float32Array, offset: number, value: Vec3 | readonly [number, number, number]): void {
  const x = value[0], y = value[1], z = value[2], length = Math.hypot(x, y, z) || 1;
  out[offset] = x / length; out[offset + 1] = y / length; out[offset + 2] = z / length;
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
