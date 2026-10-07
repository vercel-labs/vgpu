import { prepareShader } from "@vgpu/wgsl/prepare";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBindGroupCache } from "../src/bind-cache.ts";
import { InternalDraw } from "../src/draw.ts";
import { createPipelineStore } from "../src/pipeline-store.ts";
import { snapshotShaderSource } from "../src/shader-source.ts";
import { draw, frame, getMockGPUDeviceInstrumentation, init, surface, target, type Draw, type GeometryLike, type Target } from "../src/mock.ts";
import { issueWorkload } from "./fixtures/unchanged-encode.ts";

const FULLSCREEN = `@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`;
const VERTEX_INPUT = `@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`;

afterEach(() => vi.restoreAllMocks());

const internal = (item: Draw) => item as InternalDraw;

/**
 * Defers every popErrorScope so a test decides when (and with what) native validation settles.
 * `pipelineScopes` holds the resolver of each createRenderPipeline scope, in creation order.
 */
function deferredScopes(gpu: Awaited<ReturnType<typeof init>>) {
  const pending: ((error: GPUError | null) => void)[] = [];
  const pipelineScopes: ((error: GPUError | null) => void)[] = [];
  const device = gpu.gpu as GPUDevice;
  device.pushErrorScope = vi.fn();
  let nextIsPipeline = false;
  device.popErrorScope = vi.fn(() => new Promise<GPUError | null>((resolve) => {
    (nextIsPipeline ? pipelineScopes : pending).push(resolve);
    nextIsPipeline = false;
  }));
  const createRenderPipeline = device.createRenderPipeline.bind(device);
  device.createRenderPipeline = (descriptor) => { nextIsPipeline = true; return createRenderPipeline(descriptor); };
  const settleOthers = () => { for (const resolve of pending.splice(0)) resolve(null); };
  return { pipelineScopes, settleOthers };
}

function preparationCanvas() {
  const canvas = {
    width: 6,
    height: 4,
    getContext: (kind: string) => kind === "webgpu" ? { canvas, configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => { throw new Error("preparation acquired the presentation texture"); } } : null,
  } as unknown as OffscreenCanvas;
  return canvas;
}

// Issue #489: unchanged draws reuse their derived pipeline key per target, but every encode still
// asks the pipeline store, so delayed validation failures, retries and disposal stay observable.
describe("unchanged encode pipeline keys", () => {
  test("P1: each distinct target signature gets its own pipeline; returning to a target reuses it", async () => {
    const gpu = await init();
    try {
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const { draws: [item], out } = issueWorkload(gpu, 1);
      const bgra = target(gpu, { size: [8, 8], depth: true, format: "bgra8unorm" });
      const msaa = target(gpu, { size: [8, 8], depth: "depth32float", msaa: true });
      const render = (into: Target) => frame(gpu, (f) => f.pass({ target: into }, (p) => p.draw(item!)));
      render(out);
      const pipelines = mock.calls.createRenderPipeline;
      render(out); render(out);
      render(bgra); render(bgra);
      render(msaa); render(msaa);
      expect(mock.calls.createRenderPipeline).toBe(pipelines + 2);
      const formats = mock.createRenderPipelineDescriptors.slice(-2).map((descriptor) => [descriptor.fragment!.targets[0]!.format, descriptor.depthStencil?.format, descriptor.multisample?.count ?? 1]);
      expect(formats).toEqual([["bgra8unorm", "depth24plus", 1], ["rgba8unorm", "depth32float", 4]]);
      render(out); render(bgra); render(msaa);
      expect(mock.calls.createRenderPipeline).toBe(pipelines + 2);
    } finally { gpu.dispose(); }
  });

  test("P2: a dynamic layout swap invalidates the derived key", async () => {
    const gpu = await init();
    try {
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const { draws: [item], out } = issueWorkload(gpu, 1);
      const render = () => frame(gpu, (f) => f.pass({ target: out }, (p) => p.draw(item!, { offsets: { 0: [0] } })));
      render(); render();
      const pipelines = mock.calls.createRenderPipeline;
      item!.layout(0, { dynamicOffsets: true });
      render();
      expect(mock.calls.createRenderPipeline).toBe(pipelines + 1);
      expect(mock.createRenderPipelineDescriptors.at(-1)!.layout).not.toBe(mock.createRenderPipelineDescriptors.at(-2)!.layout);
      render(); render();
      expect(mock.calls.createRenderPipeline).toBe(pipelines + 1);
    } finally { gpu.dispose(); }
  });

  test("P3/P4: delayed native pipeline failure after hot hits fails the next encode of every sharing draw; retry recovers", async () => {
    const gpu = await init();
    try {
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const errors: unknown[] = [];
      gpu.onError((error) => { errors.push(error); });
      const { pipelineScopes, settleOthers } = deferredScopes(gpu);
      const { draws: [first, second], out } = issueWorkload(gpu, 2);
      const render = (item: Draw) => frame(gpu, (f) => f.pass({ target: out }, (p) => p.draw(item)));
      render(first!);
      render(second!);
      render(first!);
      render(second!);
      expect(mock.calls.createRenderPipeline).toBe(1);
      expect(pipelineScopes).toHaveLength(1);
      pipelineScopes[0]!({ message: "shader compilation failed: late" } as GPUError);
      settleOthers();
      await gpu.settled();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "VGPU-COMPILE-FAILED" });
      for (const item of [first!, second!]) {
        expect(() => render(item)).toThrowError(expect.objectContaining({ code: "VGPU-COMPILE-FAILED", message: expect.stringContaining("compilation failed") }));
      }
      expect(mock.calls.createRenderPipeline).toBe(1);
      first!.compileSync(out);
      expect(mock.calls.createRenderPipeline).toBe(2);
      pipelineScopes[1]!(null);
      settleOthers();
      await gpu.settled();
      expect(() => render(first!)).not.toThrow();
      expect(() => render(second!)).not.toThrow();
      expect(mock.calls.createRenderPipeline).toBe(2);
      expect(errors).toHaveLength(1);
      settleOthers();
    } finally { gpu.dispose(); }
  });

  test("P5: disposal of the store, the draw, the gpu or a Surface still surfaces on lookups after a memoized key", async () => {
    const gpu = await init();
    try {
      const out = target(gpu, { size: [4, 4] });
      const store = createPipelineStore(gpu.device);
      const owned = new InternalDraw(gpu.device, snapshotShaderSource(prepareShader(FULLSCREEN)), { label: "owned" }, createBindGroupCache(), undefined, store);
      owned.pipelineFor(out);
      owned.pipelineFor(out);
      store.dispose();
      expect(() => owned.pipelineFor(out)).toThrowError(expect.objectContaining({ code: "VGPU-COMPILE-DISPOSED" }));

      const screen = surface(gpu, preparationCanvas(), { autoResize: false, format: "rgba8unorm" });
      const onScreen = draw(gpu, { shader: prepareShader(`${FULLSCREEN}\n// surface`), label: "onScreen" });
      onScreen.compileSync(screen);
      onScreen.compileSync(screen);
      internal(onScreen).pipelineFor(screen);
      screen.dispose();
      expect(() => onScreen.compileSync(screen)).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-DISPOSED" }));
      expect(() => internal(onScreen).pipelineFor(screen)).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-DISPOSED" }));

      const disposed = draw(gpu, { shader: prepareShader(`${FULLSCREEN}\n// disposed`), label: "disposed" });
      disposed.draw(out);
      disposed.dispose();
      expect(() => frame(gpu, (f) => f.pass(out, (p) => p.draw(disposed)))).toThrowError(expect.objectContaining({ code: "VGPU-DRAW-DISPOSED" }));
      expect(() => internal(disposed).pipelineFor(out)).toThrowError(expect.objectContaining({ code: "VGPU-DRAW-DISPOSED" }));

      const live = draw(gpu, { shader: prepareShader(`${FULLSCREEN}\n// live`), label: "live" });
      live.draw(out);
      gpu.dispose();
      expect(() => internal(live).pipelineFor(out)).toThrowError(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
    } finally { gpu.dispose(); }
  });

  test("mutable plain geometry, custom targets and reused signature objects keep observing their current state", async () => {
    const gpu = await init();
    try {
      const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
      const vertices = gpu.gpu.createBuffer({ size: 24, usage: 0x20 | 0x08 });
      const attribute = { shaderLocation: 0, offset: 0, format: "float32x2" as GPUVertexFormat };
      const layout = { arrayStride: 8, attributes: [attribute] };
      const plain: { -readonly [K in keyof GeometryLike]: GeometryLike[K] } = { vertexCount: 3, vertexBuffers: [vertices], vertexBufferLayouts: [layout] };
      const item = internal(draw(gpu, { shader: prepareShader(VERTEX_INPUT), label: "plain", geometry: plain }));
      const out = target(gpu, { size: [4, 4] });
      const created = () => mock.calls.createRenderPipeline;
      item.pipelineFor(out);
      expect(created()).toBe(1);
      item.pipelineFor(out);
      expect(created()).toBe(1);
      attribute.format = "unorm16x2";
      item.pipelineFor(out);
      expect(created()).toBe(2);
      expect(mock.createRenderPipelineDescriptors.at(-1)!.vertex.buffers![0]!.attributes).toEqual([expect.objectContaining({ format: "unorm16x2" })]);
      layout.arrayStride = 16;
      item.pipelineFor(out);
      expect(created()).toBe(3);
      plain.topology = "line-list";
      item.pipelineFor(out);
      expect(created()).toBe(4);
      expect(mock.createRenderPipelineDescriptors.at(-1)!.primitive?.topology).toBe("line-list");
      item.pipelineFor(out);
      expect(created()).toBe(4);

      const fullscreen = internal(draw(gpu, { shader: prepareShader(FULLSCREEN), label: "custom" }));
      const color = { format: "rgba8unorm" as GPUTextureFormat };
      const custom = { colors: [color], depth: undefined as { format: GPUTextureFormat } | undefined, sampleCount: 1, renderPassDescriptor: () => ({ colorAttachments: [] }) } as unknown as Target & { colors: { format: GPUTextureFormat }[]; depth?: { format: GPUTextureFormat } };
      fullscreen.pipelineFor(custom);
      const base = created();
      fullscreen.pipelineFor(custom);
      expect(created()).toBe(base);
      color.format = "bgra8unorm";
      fullscreen.pipelineFor(custom);
      expect(created()).toBe(base + 1);
      expect(mock.createRenderPipelineDescriptors.at(-1)!.fragment!.targets).toEqual([expect.objectContaining({ format: "bgra8unorm" })]);
      custom.depth = { format: "depth24plus" };
      fullscreen.pipelineFor(custom);
      expect(created()).toBe(base + 2);

      const signature: { colors: GPUTextureFormat[]; sampleCount: 1 } = { colors: ["rgba8unorm"], sampleCount: 1 };
      fullscreen.pipelineFor(signature);
      fullscreen.pipelineFor(signature);
      const signed = created();
      signature.colors[0] = "rgba16float";
      fullscreen.pipelineFor(signature);
      expect(created()).toBe(signed + 1);
      signature.colors = [];
      expect(() => fullscreen.pipelineFor(signature)).toThrowError(expect.objectContaining({ code: "VGPU-COMPILE-SIGNATURE-INVALID" }));
    } finally { gpu.dispose(); }
  });
});
