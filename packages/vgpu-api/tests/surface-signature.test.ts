import { prepareShader } from "@vgpu/wgsl/prepare";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { expect, test, vi } from "vitest";
import { bundle, draw, effect, frame, init, surface } from "../src/mock.ts";
import type { Target } from "../src/target.ts";

const DRAW_WGSL = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let pos = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(pos[vi], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }
`;

const EFFECT_WGSL = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, 1, 0, 1); }
`;

test("every Surface preparation path uses configured metadata without presentation side effects", async () => {
  const gpu = await init();
  try {
    const configuredFormat: GPUTextureFormat = "rgba8unorm-srgb";
    const canvas = preparationCanvas();
    const screen = surface(gpu, canvas.canvas, { autoResize: false, format: configuredFormat });
    const resized = vi.fn();
    const unsubscribe = screen.onResize(resized);
    resized.mockClear();
    const submits = vi.spyOn(gpu.gpu.queue, "submit");
    const attachmentReads = rejectAttachmentReads(screen);

    const asyncDraw = draw(gpu, { shader: prepareShader(DRAW_WGSL), label: "async-draw" });
    const syncDraw = draw(gpu, { shader: prepareShader(`${DRAW_WGSL}\n// sync`), label: "sync-draw" });
    const asyncEffect = effect(gpu, prepareShader(EFFECT_WGSL), { label: "async-effect" });
    const syncEffect = effect(gpu, prepareShader(`${EFFECT_WGSL}\n// sync`), { label: "sync-effect" });
    const bundledEffect = effect(gpu, prepareShader(`${EFFECT_WGSL}\n// bundle`), { label: "bundle-effect" });

    await expect(asyncDraw.compile(screen)).resolves.toBe(asyncDraw);
    expect(syncDraw.compileSync(screen)).toBe(syncDraw);
    await expect(asyncEffect.compile(screen)).resolves.toBe(asyncEffect);
    expect(syncEffect.compileSync(screen)).toBe(syncEffect);
    const prewarmed = draw(gpu, { shader: prepareShader(`${DRAW_WGSL}\n// constructor`), targets: [screen] });
    const recorded = bundle(gpu, { target: screen, label: "surface-prepared" }, (recorder) => recorder.draw(bundledEffect));

    expect(prewarmed.gpu).toBeDefined();
    expect(recorded.gpu).toBeDefined();
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    expect(canvas.sizeWrites).toEqual([]);
    expect(resized).not.toHaveBeenCalled();
    expect(submits).not.toHaveBeenCalled();
    for (const read of attachmentReads) expect(read).not.toHaveBeenCalled();

    const instrumentation = getMockGPUDeviceInstrumentation(gpu.gpu);
    const pipelineDescriptors = [
      ...instrumentation.createRenderPipelineAsyncDescriptors,
      ...instrumentation.createRenderPipelineDescriptors,
    ];
    expect(instrumentation.createRenderPipelineAsyncDescriptors).toHaveLength(2);
    expect(instrumentation.createRenderPipelineDescriptors).toHaveLength(4);
    expect(pipelineDescriptors.every((descriptor) => Array.from(descriptor.fragment?.targets ?? [])[0]?.format === configuredFormat)).toBe(true);
    expect(pipelineDescriptors.every((descriptor) => descriptor.depthStencil === undefined && (descriptor.multisample?.count ?? 1) === 1)).toBe(true);
    expect(instrumentation.createRenderBundleEncoderDescriptors.at(-1)).toMatchObject({
      colorFormats: [configuredFormat],
      sampleCount: 1,
    });
    expect(instrumentation.createRenderBundleEncoderDescriptors.at(-1)?.depthStencilFormat).toBeUndefined();
    expect(canvas.configure).toHaveBeenCalledWith(expect.objectContaining({ format: configuredFormat }));

    recorded.dispose();
    unsubscribe();
    for (const read of attachmentReads) read.mockRestore();
  } finally {
    gpu.dispose();
  }
});

test("Surface and equivalent explicit signatures share cache and rendering acquires once per pass", async () => {
  const gpu = await init();
  try {
    const canvas = renderCanvas();
    const screen = surface(gpu, canvas.canvas, { autoResize: false, format: "rgba8unorm" });
    const drawable = draw(gpu, { shader: prepareShader(DRAW_WGSL), label: "cache-shared" });
    const instrumentation = getMockGPUDeviceInstrumentation(gpu.gpu);

    await drawable.compile(screen);
    await drawable.compile({ colors: [screen.format], depth: undefined, sampleCount: 1 });
    const recorded = bundle(gpu, { target: screen, label: "resize-stable" }, (recorder) => recorder.draw(drawable));

    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    expect(instrumentation.calls.createRenderPipelineAsync).toBe(1);
    expect(instrumentation.calls.createRenderPipeline).toBe(0);

    canvas.allowPresentation();
    frame(gpu, (currentFrame) => currentFrame.pass(screen, (pass) => {
      pass.draw(drawable);
      pass.draw(drawable);
      pass.draw(drawable);
      pass.bundles(recorded);
    }));
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
    expect(instrumentation.calls.createRenderPipelineAsync).toBe(1);
    expect(instrumentation.calls.createRenderPipeline).toBe(0);

    screen.resize([12, 8]);
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass(screen, (pass) => pass.bundles(recorded)))).not.toThrow();
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(2);
    expect(instrumentation.calls.createRenderPipelineAsync).toBe(1);
    expect(instrumentation.calls.createRenderPipeline).toBe(0);

    recorded.dispose();
    expect(() => recorded.gpu).toThrowError(expect.objectContaining({ code: "VGPU-BUNDLE-DISPOSED" }));
  } finally {
    gpu.dispose();
  }
});

test("Surface preparation checks liveness while draw and submitted-frame boundaries stay closed", async () => {
  const gpu = await init();
  try {
    const canvas = renderCanvas();
    const screen = surface(gpu, canvas.canvas, { autoResize: false, format: "rgba8unorm" });
    const drawable = draw(gpu, { shader: prepareShader(DRAW_WGSL), label: "surface-boundaries" });

    expect(() => drawable.draw(screen)).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-NOT-IN-FRAME" }));
    const submitted = frame(gpu);
    submitted.submit();
    expect(() => submitted.pass(screen, drawable)).toThrowError(expect.objectContaining({
      code: "VGPU-SURFACE-NOT-IN-FRAME",
      fix: "Encode surface draws inside frame(gpu, ...); compile(surface) and bundle(gpu, { target: surface }, ...) can prepare outside a frame.",
    }));
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();

    screen.dispose();
    expect(() => drawable.compile(screen)).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-DISPOSED" }));
    expect(() => drawable.compileSync(screen)).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-DISPOSED" }));
    expect(() => draw(gpu, { shader: prepareShader(`${DRAW_WGSL}\n// disposed constructor`), targets: [screen] })).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-DISPOSED" }));
    expect(() => bundle(gpu, { target: screen }, () => undefined)).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-DISPOSED" }));
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test("custom Targets without the private protocol retain attachment-based signature fallback", async () => {
  const gpu = await init();
  try {
    const color = gpu.device.createTexture({
      kind: "2d",
      size: [4, 4],
      format: "rgba8unorm",
      usage: ["render_attachment"],
    });
    const colors = vi.fn(() => [color] as const);
    const depth = vi.fn(() => undefined);
    const sampleCount = vi.fn(() => 1 as const);
    const custom = {
      get colors() { return colors(); },
      get depth() { return depth(); },
      get sampleCount() { return sampleCount(); },
      renderPassDescriptor: () => ({ colorAttachments: [] }),
    } as unknown as Target;
    const drawable = draw(gpu, { shader: prepareShader(DRAW_WGSL), label: "custom-fallback" });

    expect(drawable.compileSync(custom)).toBe(drawable);
    expect(colors).toHaveBeenCalledTimes(1);
    expect(depth).toHaveBeenCalledTimes(1);
    expect(sampleCount).toHaveBeenCalledTimes(1);
    expect(Array.from(getMockGPUDeviceInstrumentation(gpu.gpu).createRenderPipelineDescriptors.at(-1)?.fragment?.targets ?? [])[0]?.format).toBe(color.format);
  } finally {
    gpu.dispose();
  }
});

function preparationCanvas() {
  const sizeWrites: Array<readonly ["width" | "height", number]> = [];
  let width = 6;
  let height = 4;
  const getCurrentTexture = vi.fn(() => {
    throw new Error("preparation acquired the presentation texture");
  });
  const configure = vi.fn();
  const canvas: Record<string, unknown> = {
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return { canvas, configure, unconfigure: vi.fn(), getCurrentTexture };
    },
  };
  Object.defineProperties(canvas, {
    width: {
      configurable: true,
      get: () => width,
      set: (value: number) => { width = value; sizeWrites.push(["width", value]); },
    },
    height: {
      configurable: true,
      get: () => height,
      set: (value: number) => { height = value; sizeWrites.push(["height", value]); },
    },
  });
  return { canvas: canvas as unknown as OffscreenCanvas, configure, getCurrentTexture, sizeWrites };
}

function rejectAttachmentReads(screen: ReturnType<typeof surface>) {
  const fail = (name: string) => () => { throw new Error(`preparation read Surface.${name}`); };
  return [
    vi.spyOn(screen, "color", "get").mockImplementation(fail("color")),
    vi.spyOn(screen, "colors", "get").mockImplementation(fail("colors")),
    vi.spyOn(screen, "depth", "get").mockImplementation(fail("depth")),
    vi.spyOn(screen, "sampleCount", "get").mockImplementation(fail("sampleCount")),
    vi.spyOn(screen, "size", "get").mockImplementation(fail("size")),
  ];
}

function renderCanvas() {
  let presentationAllowed = false;
  const getCurrentTexture = vi.fn(() => {
    if (!presentationAllowed) throw new Error("preparation acquired the presentation texture");
    return { createView: () => ({}) } as GPUTexture;
  });
  const canvas = {
    width: 6,
    height: 4,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return { canvas, configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture };
    },
  } as unknown as OffscreenCanvas;
  return { canvas, getCurrentTexture, allowPresentation: () => { presentationAllowed = true; } };
}
