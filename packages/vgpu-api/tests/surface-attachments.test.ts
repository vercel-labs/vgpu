import { prepareShader } from "@vgpu/wgsl/prepare";
import { getMockGPUDeviceInstrumentation, type Texture } from "@vgpu/core";
import { expect, test, vi } from "vitest";
import { bundle, draw, effect, frame, geometry, init, surface, target } from "../src/mock.ts";
import { instanceGeometry } from "../src/scene/instance-geometry.ts";
import { instances } from "../src/scene/instances.ts";
import type { CanvasSurface } from "../src/surface.ts";

const FULLSCREEN = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[vi], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

const DEPTH_READ = `
@group(0) @binding(0) var sourceDepth: texture_depth_2d;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[vi], 0, 1);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let depth = textureLoad(sourceDepth, vec2i(position.xy), 0);
  return vec4f(depth, depth, depth, 1);
}
`;

test("a depth+MSAA Surface owns matching attachments and resolves into the presentation texture", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const allocated: Texture[] = [];
    const createTexture = gpu.device.createTexture.bind(gpu.device);
    vi.spyOn(gpu.device, "createTexture").mockImplementation((options) => {
      const texture = createTexture(options);
      allocated.push(texture);
      return texture;
    });

    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      msaa: true,
      size: [8, 6],
    });

    expect(screen.sampleCount).toBe(4);
    expect(screen.depth).toMatchObject({
      format: "depth24plus",
      sampleCount: 4,
      size: [8, 6],
      usage: expect.arrayContaining(["render_attachment", "texture_binding"]),
    });
    expect(allocated.map((texture) => texture.options)).toEqual([
      expect.objectContaining({ format: "rgba8unorm", sampleCount: 4, size: [8, 6], usage: ["render_attachment"] }),
      expect.objectContaining({ format: "depth24plus", sampleCount: 4, size: [8, 6], usage: ["render_attachment", "texture_binding"] }),
    ]);
    const msaaView = {} as GPUTextureView;
    const depthView = {} as GPUTextureView;
    vi.spyOn(allocated[0]!, "createView").mockReturnValue(msaaView);
    vi.spyOn(allocated[1]!, "createView").mockReturnValue(depthView);

    const descriptor = screen.renderPassDescriptor({ clear: [0.25, 0.5, 0.75, 1], clearDepth: 0.5 });
    expect(descriptor.colorAttachments).toEqual([{
      view: msaaView,
      resolveTarget: canvas.presentationView,
      loadOp: "clear",
      storeOp: "discard",
      clearValue: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
    }]);
    expect(descriptor.depthStencilAttachment).toEqual({
      view: depthView,
      depthLoadOp: "clear",
      depthStoreOp: "discard",
      depthClearValue: 0.5,
    });
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});

test("resize publishes a coherent owned generation, destroys old depth, and skips same-size work", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const createTexture = vi.spyOn(gpu.device, "createTexture");
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      msaa: 4,
      size: [8, 6],
    });
    const oldDepth = screen.depth!;
    const resized = vi.fn();
    const unsubscribe = screen.onResize(resized);
    resized.mockClear();
    createTexture.mockClear();

    screen.resize([12, 10]);

    expect(screen.size).toEqual([12, 10]);
    expect(screen.depth).not.toBe(oldDepth);
    expect(screen.depth).toMatchObject({ size: [12, 10], sampleCount: 4 });
    expect(() => oldDepth.view).toThrowError(/destroyed/i);
    expect(createTexture).toHaveBeenCalledTimes(2);
    expect(resized).toHaveBeenCalledWith(expect.objectContaining({ width: 12, height: 10, surface: screen }));
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();

    createTexture.mockClear();
    resized.mockClear();
    screen.resize([12, 10]);
    expect(createTexture).not.toHaveBeenCalled();
    expect(resized).not.toHaveBeenCalled();
    unsubscribe();
  } finally {
    gpu.dispose();
  }
});

test("resize runs every listener and old-generation cleanup before propagating a callback failure", async () => {
  const gpu = await init();
  try {
    const screen = surface(gpu, canvasFixture(8, 6).canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      size: [8, 6],
    }) as CanvasSurface;
    const oldDepth = screen.depth!;
    const order: string[] = [];
    let resizing = false;
    screen.onTexturesRecreated!(() => {
      order.push("textures-1");
      expect(() => screen.resize([14, 10])).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-RESIZE-REENTRANT" }));
      throw new Error("texture listener failed");
    });
    screen.onTexturesRecreated!(() => { order.push("textures-2"); });
    screen.onResize(() => {
      if (!resizing) return;
      order.push("resize-1");
      expect(() => screen.resize([14, 10])).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-RESIZE-REENTRANT" }));
      throw new Error("resize listener failed");
    });
    screen.onResize(() => { if (resizing) order.push("resize-2"); });

    resizing = true;
    expect(() => screen.resize([12, 10])).toThrow("texture listener failed");
    expect(order).toEqual(["textures-1", "textures-2", "resize-1", "resize-2"]);
    expect(screen.size).toEqual([12, 10]);
    expect(screen.depth).not.toBe(oldDepth);
    expect(() => oldDepth.view).toThrowError(/destroyed/i);

    resizing = false;
    expect(() => screen.resize([14, 10])).toThrow("texture listener failed");
    expect(screen.size).toEqual([14, 10]);
  } finally {
    gpu.dispose();
  }
});

test("an immediate onResize subscription cannot clear an outer texture-recreated resize guard", async () => {
  const gpu = await init();
  try {
    const screen = surface(gpu, canvasFixture(8, 6).canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      size: [8, 6],
    }) as CanvasSurface;
    const oldDepth = screen.depth!;
    let replacementCallbacks = 0;
    const immediate: Array<readonly [number, number]> = [];
    screen.onTexturesRecreated!(() => {
      replacementCallbacks += 1;
      if (replacementCallbacks > 1) return;
      const unsubscribe = screen.onResize(({ width, height }) => immediate.push([width, height]));
      expect(() => screen.resize([14, 10])).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-RESIZE-REENTRANT" }));
      unsubscribe();
    });

    expect(() => screen.resize([12, 9])).not.toThrow();
    expect(replacementCallbacks).toBe(1);
    expect(immediate).toEqual([[12, 9]]);
    expect(screen.size).toEqual([12, 9]);
    expect(screen.depth).not.toBe(oldDepth);
    expect(screen.depth?.size).toEqual([12, 9]);
    expect(() => oldDepth.view).toThrowError(/destroyed/i);
  } finally {
    gpu.dispose();
  }
});

test("descriptor reconciliation cannot clear an immediate onResize guard inside a frame", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      size: [8, 6],
    });
    const oldDepth = screen.depth!;
    const drawable = draw(gpu, { shader: prepareShader(FULLSCREEN), label: "surface-drift-inside-resize-listener" });
    let callbackCount = 0;
    let reconciledDepth: Texture | undefined;

    frame(gpu, (current) => {
      canvas.canvas.width = 12;
      canvas.canvas.height = 9;
      screen.onResize(() => {
        callbackCount += 1;
        if (callbackCount > 1) return;
        current.pass(screen, drawable);
        reconciledDepth = screen.depth;
        expect(reconciledDepth).not.toBe(oldDepth);
        expect(reconciledDepth?.size).toEqual([12, 9]);
        expect(() => screen.resize([14, 10])).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-RESIZE-REENTRANT" }));
      });
    });

    expect(callbackCount).toBe(1);
    expect(screen.size).toEqual([12, 9]);
    expect(screen.depth).toBe(reconciledDepth);
    expect(() => oldDepth.view).toThrowError(/destroyed/i);
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});

test.each([
  { name: "default", attachments: {} },
  { name: "depth+MSAA", attachments: { depth: true, msaa: true } },
] as const)("immediate onResize observes live external dimensions without reconciling a $name Surface", async ({ attachments }) => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const createTexture = vi.spyOn(gpu.device, "createTexture");
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      dpr: 1.5,
      format: "rgba8unorm",
      size: [8, 6],
      ...attachments,
    }) as CanvasSurface;
    const oldDepth = screen.depth;
    const recreated = vi.fn();
    screen.onTexturesRecreated(recreated);
    createTexture.mockClear();
    canvas.canvas.width = 12;
    canvas.canvas.height = 9;

    const immediate: Array<readonly [number, number, number]> = [];
    screen.onResize(({ width, height, dpr }) => immediate.push([width, height, dpr]));

    expect(immediate).toEqual([[12, 9, 1.5]]);
    expect(screen.size).toEqual([12, 9]);
    expect(screen.depth).toBe(oldDepth);
    expect(createTexture).not.toHaveBeenCalled();
    expect(recreated).not.toHaveBeenCalled();
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    if (oldDepth) {
      expect(oldDepth.size).toEqual([8, 6]);
      expect(() => oldDepth.view).not.toThrow();
    }
  } finally {
    gpu.dispose();
  }
});

test.each([
  { name: "default", attachments: {} },
  { name: "depth+MSAA", attachments: { depth: true, msaa: true } },
] as const)("direct canvas drift stays silent after an earlier offscreen pass on a $name Surface", async ({ attachments }) => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      format: "rgba8unorm",
      size: [8, 6],
      ...attachments,
    }) as CanvasSurface;
    const derived = target(gpu, { size: [8, 6], format: "rgba8unorm" });
    const oldDerivedColor = derived.color;
    const oldDepth = screen.depth;
    const publicResizes: Array<readonly [number, number]> = [];
    const recreated = vi.fn();
    screen.onTexturesRecreated(recreated);
    screen.onResize(({ width, height }) => {
      publicResizes.push([width, height]);
      derived.resize([width, height]);
    });
    publicResizes.length = 0;

    const offscreenDraw = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, 0, 1, 1); }`));
    const surfaceDraw = draw(gpu, { shader: prepareShader(FULLSCREEN), label: "surface-after-external-drift" });
    frame(gpu, (current) => {
      current.pass(derived, offscreenDraw);
      canvas.canvas.width = 12;
      canvas.canvas.height = 9;

      surfaceDraw.compileSync(screen);
      expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
      expect(screen.depth).toBe(oldDepth);
      expect(recreated).not.toHaveBeenCalled();

      current.pass(screen, surfaceDraw);
    });

    expect(publicResizes).toEqual([]);
    expect(derived.size).toEqual([8, 6]);
    expect(derived.color).toBe(oldDerivedColor);
    expect(() => oldDerivedColor.view).not.toThrow();
    expect(recreated).toHaveBeenCalledTimes(1);
    expect(screen.size).toEqual([12, 9]);
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
    if (oldDepth) {
      expect(screen.depth).not.toBe(oldDepth);
      expect(screen.depth?.size).toEqual([12, 9]);
      expect(() => oldDepth.view).toThrowError(/destroyed/i);
    } else {
      expect(screen.depth).toBeUndefined();
    }
  } finally {
    gpu.dispose();
  }
});

test("frame start silently reconciles external depth drift before user encoding", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      size: [8, 6],
    }) as CanvasSurface;
    const output = target(gpu, { size: [12, 9], format: "rgba8unorm" });
    const oldDepth = screen.depth!;
    const inspect = draw(gpu, { shader: prepareShader(DEPTH_READ), depth: false, label: "inspect-pre-frame-depth", set: { sourceDepth: oldDepth } });
    const recreated = vi.fn();
    const resized = vi.fn();
    screen.onTexturesRecreated(recreated);
    screen.onResize(resized);
    resized.mockClear();
    canvas.canvas.width = 12;
    canvas.canvas.height = 9;

    frame(gpu, (current) => {
      expect(recreated).toHaveBeenCalledTimes(1);
      expect(resized).not.toHaveBeenCalled();
      expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
      expect(screen.depth).not.toBe(oldDepth);
      expect(screen.depth?.size).toEqual([12, 9]);
      expect(() => oldDepth.view).toThrowError(/destroyed/i);
      expect(() => current.pass(output, inspect)).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));

      inspect.set({ sourceDepth: screen.depth! });
      expect(() => current.pass(output, inspect)).not.toThrow();
    });

    expect(resized).not.toHaveBeenCalled();
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test.each([
  { name: "default", depth: false, expectedStaleEvents: [] },
  { name: "owned depth", depth: true, expectedStaleEvents: [[12, 9]] },
] as const)("explicit resize preserves $name notification rules after direct canvas drift", async ({ depth, expectedStaleEvents }) => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth,
      format: "rgba8unorm",
      size: [8, 6],
    }) as CanvasSurface;
    const oldDepth = screen.depth;
    const publicResizes: Array<readonly [number, number]> = [];
    const recreated = vi.fn();
    screen.onTexturesRecreated(recreated);
    screen.onResize(({ width, height }) => publicResizes.push([width, height]));
    publicResizes.length = 0;
    canvas.canvas.width = 12;
    canvas.canvas.height = 9;

    screen.resize([12, 9]);

    expect(publicResizes).toEqual(expectedStaleEvents);
    expect(recreated).toHaveBeenCalledTimes(1);
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    if (oldDepth) {
      expect(screen.depth).not.toBe(oldDepth);
      expect(screen.depth?.size).toEqual([12, 9]);
      expect(() => oldDepth.view).toThrowError(/destroyed/i);
    } else {
      expect(screen.depth).toBeUndefined();
    }

    publicResizes.length = 0;
    recreated.mockClear();
    screen.resize([14, 10]);
    expect(publicResizes).toEqual([[14, 10]]);
    expect(recreated).toHaveBeenCalledTimes(1);
    expect(screen.size).toEqual([14, 10]);
  } finally {
    gpu.dispose();
  }
});

test("render reconciliation aborts before presentation acquisition when external canvas drift cannot allocate", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      msaa: true,
      size: [8, 6],
    }) as CanvasSurface;
    const oldDepth = screen.depth!;
    const resized = vi.fn();
    const recreated = vi.fn();
    screen.onTexturesRecreated(recreated);
    screen.onResize(resized);
    resized.mockClear();
    canvas.canvas.width = 14;
    canvas.canvas.height = 9;

    const createTexture = vi.spyOn(gpu.device, "createTexture").mockImplementation(() => {
      throw new Error("external drift allocation failed");
    });
    expect(() => screen.renderPassDescriptor()).toThrow("external drift allocation failed");
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    expect(screen.size).toEqual([14, 9]);
    expect(screen.depth).toBe(oldDepth);
    expect(() => oldDepth.view).not.toThrow();
    expect(recreated).not.toHaveBeenCalled();
    expect(resized).not.toHaveBeenCalled();

    createTexture.mockRestore();
    expect(() => screen.renderPassDescriptor()).not.toThrow();
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
    expect(screen.depth).not.toBe(oldDepth);
    expect(screen.depth?.size).toEqual([14, 9]);
    expect(() => oldDepth.view).toThrowError(/destroyed/i);
    expect(recreated).toHaveBeenCalledTimes(1);
    expect(resized).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test.each([1, 2])("construction failure at owned allocation %i cleans partial textures and leaves the canvas reusable", async (failure) => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const createTexture = gpu.device.createTexture.bind(gpu.device);
    const prepared: Texture[] = [];
    let calls = 0;
    const spy = vi.spyOn(gpu.device, "createTexture").mockImplementation((options) => {
      if (++calls === failure) throw new Error(`construction allocation ${failure} failed`);
      const texture = createTexture(options);
      prepared.push(texture);
      return texture;
    });

    expect(() => surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      msaa: true,
      size: [10, 7],
    })).toThrow(`construction allocation ${failure} failed`);
    expect(canvas.unconfigure).toHaveBeenCalledTimes(1);
    expect(canvas.canvas.width).toBe(8);
    expect(canvas.canvas.height).toBe(6);
    for (const texture of prepared) expect(() => texture.view).toThrowError(/destroyed/i);

    spy.mockRestore();
    const reused = surface(gpu, canvas.canvas, { autoResize: false, depth: true, format: "rgba8unorm", msaa: true });
    expect(reused.depth).toBeDefined();
  } finally {
    gpu.dispose();
  }
});

test.each([1, 2])("resize failure at owned allocation %i destroys partial replacements and preserves the old generation", async (failure) => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      msaa: true,
      size: [8, 6],
    });
    const oldDepth = screen.depth!;
    const resized = vi.fn();
    screen.onResize(resized);
    resized.mockClear();
    const createTexture = gpu.device.createTexture.bind(gpu.device);
    const prepared: Texture[] = [];
    let calls = 0;
    const spy = vi.spyOn(gpu.device, "createTexture").mockImplementation((options) => {
      if (++calls === failure) throw new Error(`resize allocation ${failure} failed`);
      const texture = createTexture(options);
      prepared.push(texture);
      return texture;
    });

    expect(() => screen.resize([12, 10])).toThrow(`resize allocation ${failure} failed`);
    expect(screen.size).toEqual([8, 6]);
    expect(screen.depth).toBe(oldDepth);
    expect(() => oldDepth.view).not.toThrow();
    expect(resized).not.toHaveBeenCalled();
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    for (const texture of prepared) expect(() => texture.view).toThrowError(/destroyed/i);

    spy.mockRestore();
    screen.resize([12, 10]);
    expect(screen.depth?.size).toEqual([12, 10]);
  } finally {
    gpu.dispose();
  }
});

test.each([
  { depth: undefined, format: undefined, msaa: false, sampleCount: 1 },
  { depth: true, format: "depth24plus", msaa: false, sampleCount: 1 },
  { depth: "depth24plus-stencil8" as const, format: "depth24plus-stencil8", msaa: false, sampleCount: 1 },
  { depth: undefined, format: undefined, msaa: true, sampleCount: 4 },
  { depth: true, format: "depth24plus", msaa: 4 as const, sampleCount: 4 },
  { depth: "depth24plus-stencil8" as const, format: "depth24plus-stencil8", msaa: true, sampleCount: 4 },
])("resolves depth $format and sample count $sampleCount without changing the presentation color contract", async ({ depth, format, msaa, sampleCount }) => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(6, 4);
    const screen = surface(gpu, canvas.canvas, { autoResize: false, depth, format: "rgba8unorm", msaa, size: [6, 4] });
    expect(screen.sampleCount).toBe(sampleCount);
    expect(screen.depth?.format).toBe(format);
    expect(screen.depth?.sampleCount).toBe(format ? sampleCount : undefined);
    expect(screen.format).toBe("rgba8unorm");
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    const color = screen.color;
    expect(color.format).toBe("rgba8unorm");
    expect(color.sampleCount).toBe(1);
    expect(canvas.getCurrentTexture).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});

test.each(["rgba8unorm", "stencil8", "", null, 2])("invalid Surface depth %j uses the Surface-specific error", async (depth) => {
  const gpu = await init();
  try {
    expect(() => surface(gpu, canvasFixture(4, 4).canvas, { depth: depth as never, format: "rgba8unorm" })).toThrowError(
      expect.objectContaining({ code: "VGPU-SURFACE-DEPTH-INVALID" }),
    );
  } finally {
    gpu.dispose();
  }
});

test.each([1, 2, 8, "4", null])("invalid Surface msaa %j uses the Surface-specific error", async (msaa) => {
  const gpu = await init();
  try {
    expect(() => surface(gpu, canvasFixture(4, 4).canvas, { format: "rgba8unorm", msaa: msaa as never })).toThrowError(
      expect.objectContaining({ code: "VGPU-SURFACE-MSAA-INVALID" }),
    );
  } finally {
    gpu.dispose();
  }
});

test("preferred format and mutable option bags are snapshotted for owned attachments", async () => {
  vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: vi.fn(() => "rgba8unorm-srgb") } });
  const gpu = await init();
  try {
    const options: {
      autoResize: boolean;
      depth: boolean | GPUTextureFormat;
      msaa: boolean | 4;
      size: readonly [number, number];
    } = { autoResize: false, depth: true, msaa: true, size: [6, 4] };
    const screen = surface(gpu, canvasFixture(6, 4).canvas, options);
    options.depth = false;
    options.msaa = false;
    screen.resize([8, 5]);
    expect(screen.format).toBe("rgba8unorm-srgb");
    expect(screen.sampleCount).toBe(4);
    expect(screen.depth).toMatchObject({ format: "depth24plus", sampleCount: 4, size: [8, 5] });
  } finally {
    gpu.dispose();
    vi.unstubAllGlobals();
  }
});

test("combined depth descriptors cover clear, preserve, read-only, and MSAA discard semantics", async () => {
  const gpu = await init();
  try {
    const single = surface(gpu, canvasFixture(6, 4).canvas, {
      autoResize: false,
      depth: "depth24plus-stencil8",
      format: "rgba8unorm",
      size: [6, 4],
    });
    expect(single.renderPassDescriptor({ clearDepth: 0.25, clearStencil: 9 }).depthStencilAttachment).toMatchObject({
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 0.25,
      stencilLoadOp: "clear",
      stencilStoreOp: "store",
      stencilClearValue: 9,
    });
    expect(single.renderPassDescriptor({ preserve: true }).depthStencilAttachment).toEqual(expect.objectContaining({
      depthLoadOp: "load",
      depthStoreOp: "store",
      stencilLoadOp: "load",
      stencilStoreOp: "store",
    }));
    expect(single.renderPassDescriptor({ depthReadOnly: true }).depthStencilAttachment).toEqual(expect.objectContaining({
      depthReadOnly: true,
      stencilReadOnly: true,
    }));
    expect(single.renderPassDescriptor({ depthReadOnly: true }).depthStencilAttachment).not.toHaveProperty("depthLoadOp");

    const multisampled = surface(gpu, canvasFixture(6, 4).canvas, {
      autoResize: false,
      depth: "depth24plus-stencil8",
      format: "rgba8unorm",
      msaa: true,
      size: [6, 4],
    });
    expect(multisampled.renderPassDescriptor().depthStencilAttachment).toMatchObject({
      depthStoreOp: "discard",
      stencilStoreOp: "discard",
    });
    expect(() => frame(gpu, (current) => current.pass({ target: multisampled, clear: false }, () => undefined))).toThrowError(
      expect.objectContaining({ code: "VGPU-PASS-PRESERVE-MSAA" }),
    );
    expect(() => frame(gpu, (current) => current.pass({ target: multisampled, depthReadOnly: true }, () => undefined))).toThrowError(
      expect.objectContaining({ code: "VGPU-PASS-DEPTH-READONLY-MSAA" }),
    );
  } finally {
    gpu.dispose();
  }
});

test("layout-backed DPR changes and buffer-only manual resizes keep owned attachments aligned", async () => {
  vi.stubGlobal("devicePixelRatio", 2);
  const gpu = await init();
  try {
    const layout = canvasFixture(0, 0);
    Object.assign(layout.canvas, { clientWidth: 10, clientHeight: 5 });
    const automatic = surface(gpu, layout.canvas as unknown as HTMLCanvasElement, { depth: true, format: "rgba8unorm", msaa: true });
    expect(automatic.size).toEqual([20, 10]);
    expect(automatic.depth?.size).toEqual([20, 10]);

    Object.assign(layout.canvas, { clientWidth: 12, clientHeight: 7 });
    vi.stubGlobal("devicePixelRatio", 1.5);
    frame(gpu);
    expect(automatic.dpr).toBe(1.5);
    expect(automatic.size).toEqual([18, 11]);
    expect(automatic.depth?.size).toEqual([18, 11]);

    const offscreen = surface(gpu, canvasFixture(9, 4).canvas, { autoResize: false, depth: true, format: "rgba8unorm" });
    offscreen.resize([13.9, 6.8]);
    expect(offscreen.size).toEqual([13, 6]);
    expect(offscreen.depth?.size).toEqual([13, 6]);
  } finally {
    gpu.dispose();
    vi.unstubAllGlobals();
  }
});

test("dispose cleans every owned attachment after listener failure, never destroys presentation images, and frees the canvas", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const allocated: Texture[] = [];
    const createTexture = gpu.device.createTexture.bind(gpu.device);
    vi.spyOn(gpu.device, "createTexture").mockImplementation((options) => {
      const texture = createTexture(options);
      allocated.push(texture);
      return texture;
    });
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: true,
      format: "rgba8unorm",
      msaa: true,
    });
    screen.renderPassDescriptor();
    screen.onDestroy(() => { throw new Error("surface destroy listener failed"); });

    expect(() => screen.dispose()).toThrow("surface destroy listener failed");
    expect(screen.disposed).toBe(true);
    expect(canvas.unconfigure).toHaveBeenCalledTimes(1);
    expect((canvas.presentation as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
    for (const texture of allocated) expect(() => texture.view).toThrowError(/destroyed/i);
    expect(() => screen.dispose()).not.toThrow();
    expect(canvas.unconfigure).toHaveBeenCalledTimes(1);

    const reused = surface(gpu, canvas.canvas, { autoResize: false, depth: true, format: "rgba8unorm" });
    expect(reused.disposed).toBe(false);
  } finally {
    gpu.dispose();
  }
});

test("configured signatures use depth/MSAA without attachment acquisition and bundles survive resize and temporary mismatch", async () => {
  const gpu = await init();
  try {
    const canvas = canvasFixture(8, 6);
    const screen = surface(gpu, canvas.canvas, {
      autoResize: false,
      depth: "depth24plus-stencil8",
      format: "rgba8unorm",
      msaa: true,
      size: [8, 6],
    });
    const attachmentReads = [
      vi.spyOn(screen, "color", "get").mockImplementation(() => { throw new Error("read color"); }),
      vi.spyOn(screen, "colors", "get").mockImplementation(() => { throw new Error("read colors"); }),
      vi.spyOn(screen, "depth", "get").mockImplementation(() => { throw new Error("read depth"); }),
      vi.spyOn(screen, "sampleCount", "get").mockImplementation(() => { throw new Error("read sampleCount"); }),
      vi.spyOn(screen, "size", "get").mockImplementation(() => { throw new Error("read size"); }),
    ];
    const drawable = draw(gpu, { shader: prepareShader(FULLSCREEN), label: "surface-signature" });

    expect(drawable.compileSync(screen)).toBe(drawable);
    const recorded = bundle(gpu, { target: screen, label: "surface-depth-msaa" }, (recorder) => recorder.draw(drawable));
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    for (const read of attachmentReads) expect(read).not.toHaveBeenCalled();
    const instrumentation = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect(instrumentation.createRenderPipelineDescriptors.at(-1)).toMatchObject({
      depthStencil: { format: "depth24plus-stencil8" },
      multisample: { count: 4 },
    });
    expect(instrumentation.createRenderBundleEncoderDescriptors.at(-1)).toMatchObject({
      colorFormats: ["rgba8unorm"],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: 4,
    });
    for (const read of attachmentReads) read.mockRestore();

    screen.resize([12, 10]);
    expect(canvas.getCurrentTexture).not.toHaveBeenCalled();
    expect(() => frame(gpu, (current) => current.pass(screen, (pass) => pass.bundles(recorded)))).not.toThrow();
    const incompatible = target(gpu, { size: [12, 10], depth: "depth24plus-stencil8", format: "rgba8unorm" });
    expect(() => frame(gpu, (current) => current.pass(incompatible, (pass) => pass.bundles(recorded)))).toThrowError(
      expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
    );
    expect(() => frame(gpu, (current) => current.pass(screen, (pass) => pass.bundles(recorded)))).not.toThrow();
    recorded.dispose();
  } finally {
    gpu.dispose();
  }
});

test("explicit single-sample Surface depth bindings invalidate on resize and work after rebinding", async () => {
  const gpu = await init();
  try {
    const screen = surface(gpu, canvasFixture(8, 6).canvas, { autoResize: false, depth: true, format: "rgba8unorm" });
    const output = target(gpu, { size: [8, 6], format: "rgba8unorm" });
    const oldDepth = screen.depth!;
    const inspect = draw(gpu, { shader: prepareShader(DEPTH_READ), depth: false, label: "inspect-surface-depth", set: { sourceDepth: oldDepth } });
    expect(() => frame(gpu, (current) => current.pass(output, inspect))).not.toThrow();
    expect(() => inspect.set({ sourceDepth: screen })).toThrowError(expect.objectContaining({ code: "VGPU-SURFACE-NOT-BINDABLE" }));

    screen.resize([10, 7]);
    expect(() => frame(gpu, (current) => current.pass(output, inspect))).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
    inspect.set({ sourceDepth: screen.depth! });
    expect(() => frame(gpu, (current) => current.pass(output, inspect))).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("scene instance publication, count, and liveness remain intact on a depth Surface", async () => {
  const gpu = await init();
  try {
    const screen = surface(gpu, canvasFixture(8, 6).canvas, { autoResize: false, depth: true, format: "rgba8unorm" });
    const mesh = geometry(gpu, {
      buffers: [{
        data: new Float32Array([-0.5, -0.5, 0.5, -0.5, 0, 0.5]),
        attributes: { position: { format: "float32x2", location: 0 } },
      }],
    });
    const collection = instances({ capacity: 1 });
    collection.add();
    const bridge = instanceGeometry(gpu, collection, { mesh });
    expect(bridge.publish()).toBe(1);
    const scene = draw(gpu, {
      geometry: bridge.geometry,
      shader: prepareShader(`
        struct Out { @builtin(position) position: vec4f }
        @vertex fn vs_main(
          @location(0) position: vec2f,
          @location(1) world0: vec4f,
          @location(2) world1: vec4f,
          @location(3) world2: vec4f,
          @location(4) world3: vec4f,
        ) -> Out {
          var out: Out;
          out.position = mat4x4f(world0, world1, world2, world3) * vec4f(position, 0, 1);
          return out;
        }
        @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
      `),
    });
    expect(() => frame(gpu, (current) => current.pass(screen, (pass) => pass.draw(scene, { instances: 1 })))).not.toThrow();
    mesh.destroy();
    expect(() => frame(gpu, (current) => current.pass(screen, (pass) => pass.draw(scene, { instances: 1 })))).toThrowError(
      expect.objectContaining({ code: "VGPU-INSTANCE-DESTROYED" }),
    );
  } finally {
    gpu.dispose();
  }
});

function canvasFixture(width: number, height: number) {
  const presentationView = {} as GPUTextureView;
  const presentation = { createView: vi.fn(() => presentationView), destroy: vi.fn() } as unknown as GPUTexture;
  const getCurrentTexture = vi.fn(() => presentation);
  const configure = vi.fn();
  const unconfigure = vi.fn();
  const canvas = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return { canvas, configure, unconfigure, getCurrentTexture };
    },
  } as unknown as OffscreenCanvas;
  return { canvas, configure, getCurrentTexture, presentation, presentationView, unconfigure };
}
