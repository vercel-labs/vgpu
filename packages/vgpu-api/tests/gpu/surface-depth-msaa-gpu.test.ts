import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { draw, effect, frame, geometry, init, surface, target } from "../../src/node.ts";
import { instanceGeometry } from "../../src/scene/instance-geometry.ts";
import { instances } from "../../src/scene/instances.ts";

const FULLSCREEN_AT_DEPTH = (z: number, color: readonly [number, number, number]) => `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[vi], ${z}, 1);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(${color[0]}, ${color[1]}, ${color[2]}, 1);
}
`;

const DIAGONAL = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1));
  return vec4f(positions[vi], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

const INSTANCED = `
struct VertexOut { @builtin(position) position: vec4f }
@vertex fn vs_main(
  @location(0) position: vec2f,
  @location(1) world0: vec4f,
  @location(2) world1: vec4f,
  @location(3) world2: vec4f,
  @location(4) world3: vec4f,
) -> VertexOut {
  var out: VertexOut;
  out.position = mat4x4f(world0, world1, world2, world3) * vec4f(position, 0.2, 1);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.7, 1, 1); }
`;

const READ_DEPTH_UNFILTERABLE = `
@group(0) @binding(0) var sceneDepth: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[vi], 0, 1);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let depth = textureLoad(sceneDepth, vec2i(position.xy), 0).x;
  return vec4f(depth, 1.0 - depth, 0.0, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("Surface depth/MSAA native GPU acceptance", () => {
  test("depth occludes a farther draw submitted second while the no-depth control overwrites it", async () => {
    const gpu = await init();
    try {
      const withDepth = surface(gpu, gpuCanvasLike(16, 16), { autoResize: false, depth: true, format: "rgba8unorm" });
      const control = surface(gpu, gpuCanvasLike(16, 16), { autoResize: false, format: "rgba8unorm" });
      const near = draw(gpu, { shader: prepareShader(FULLSCREEN_AT_DEPTH(0.2, [1, 0, 0])), label: "near" });
      const far = draw(gpu, { shader: prepareShader(FULLSCREEN_AT_DEPTH(0.8, [0, 1, 0])), label: "far" });

      frame(gpu, (current) => {
        current.pass(withDepth, (pass) => { pass.draw(near); pass.draw(far); });
        current.pass(control, (pass) => { pass.draw(near); pass.draw(far); });
      });

      expect(pixelAt(await withDepth.color.read({ mipLevel: 0, region: "all" }), 16, 8, 8)).toEqual([255, 0, 0, 255]);
      expect(pixelAt(await control.color.read({ mipLevel: 0, region: "all" }), 16, 8, 8)).toEqual([0, 255, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("4x MSAA resolves partial diagonal coverage, the 1x control stays binary, and resize re-renders", async () => {
    const gpu = await init();
    try {
      const multisampled = surface(gpu, gpuCanvasLike(32, 32), { autoResize: false, format: "rgba8unorm", msaa: 4 });
      const control = surface(gpu, gpuCanvasLike(32, 32), { autoResize: false, format: "rgba8unorm" });
      const diagonal = draw(gpu, { shader: prepareShader(DIAGONAL), label: "diagonal" });
      frame(gpu, (current) => {
        current.pass(multisampled, diagonal);
        current.pass(control, diagonal);
      });

      const msaaPixels = await multisampled.color.read({ mipLevel: 0, region: "all" });
      const controlPixels = await control.color.read({ mipLevel: 0, region: "all" });
      expect(partialRedPixels(msaaPixels)).toBeGreaterThan(0);
      expect(partialRedPixels(controlPixels)).toBe(0);

      multisampled.resize([20, 12]);
      const cyan = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, 1, 1, 1); }`));
      frame(gpu, (current) => current.pass(multisampled, cyan));
      const resized = await multisampled.color.read({ mipLevel: 0, region: "all" });
      expect(resized.byteLength).toBe(20 * 12 * 4);
      expect(pixelAt(resized, 20, 10, 6)).toEqual([0, 255, 255, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("external canvas drift after an offscreen pass stays silent and preserves the encoded attachments", async () => {
    const gpu = await init();
    try {
      const canvas = gpuCanvasLike(12, 8);
      const screen = surface(gpu, canvas, { autoResize: false, depth: true, format: "rgba8unorm", msaa: true });
      const derived = target(gpu, { size: [12, 8], format: "rgba8unorm" });
      const encodedColor = derived.color;
      const publicResizes: Array<readonly [number, number]> = [];
      screen.onResize(({ width, height }) => {
        publicResizes.push([width, height]);
        derived.resize([width, height]);
      });
      publicResizes.length = 0;
      const blue = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, 0, 1, 1); }`));
      const yellow = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 1, 0, 1); }`));

      frame(gpu, (current) => {
        current.pass(derived, blue);
        canvas.width = 16;
        canvas.height = 10;
        current.pass(screen, yellow);
      });

      expect(publicResizes).toEqual([]);
      expect(derived.size).toEqual([12, 8]);
      expect(derived.color).toBe(encodedColor);
      expect(pixelAt(await encodedColor.read({ mipLevel: 0, region: "all" }), 12, 6, 4)).toEqual([0, 0, 255, 255]);
      expect(screen.depth?.size).toEqual([16, 10]);
      expect(pixelAt(await screen.color.read({ mipLevel: 0, region: "all" }), 16, 8, 5)).toEqual([255, 255, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("pre-frame external drift replaces depth before encoding and accepts a live rebind", async () => {
    const gpu = await init();
    try {
      const errors: unknown[] = [];
      gpu.onError((error) => errors.push(error));
      const canvas = gpuCanvasLike(12, 8);
      const screen = surface(gpu, canvas, { autoResize: false, depth: true, format: "rgba8unorm" });
      const output = target(gpu, { size: [16, 10], format: "rgba8unorm" });
      const oldDepth = screen.depth!;
      const inspectDepth = draw(gpu, {
        shader: prepareShader(READ_DEPTH_UNFILTERABLE),
        depth: false,
        label: "inspect-reconciled-depth",
        set: { sceneDepth: oldDepth },
      });
      const writeDepth = draw(gpu, { shader: prepareShader(FULLSCREEN_AT_DEPTH(0.25, [1, 0, 0])), label: "write-reconciled-depth" });
      const publicResizes: Array<readonly [number, number]> = [];
      screen.onResize(({ width, height }) => publicResizes.push([width, height]));
      publicResizes.length = 0;
      canvas.width = 16;
      canvas.height = 10;

      const submitted = frame(gpu, (current) => {
        expect(screen.depth).not.toBe(oldDepth);
        expect(screen.depth?.size).toEqual([16, 10]);
        expect(() => oldDepth.view).toThrowError(/destroyed/i);
        expect(() => current.pass(output, inspectDepth)).toThrowError(
          expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }),
        );

        current.pass(screen, writeDepth);
        inspectDepth.set({ sceneDepth: screen.depth! });
        current.pass(output, inspectDepth);
      });

      await submitted.done;
      await gpu.settled();
      expect(errors).toEqual([]);
      expect(publicResizes).toEqual([]);
      const sampled = pixelAt(await output.color.read({ mipLevel: 0, region: "all" }), 16, 8, 5);
      expect(sampled[0]).toBeGreaterThan(55);
      expect(sampled[0]).toBeLessThan(75);
      expect(sampled[1]).toBeGreaterThan(180);
      expect(sampled[1]).toBeLessThan(200);
    } finally {
      gpu.dispose();
    }
  });

  test("scene instance geometry renders directly and single-sample depth is read-only sampleable in compatibility mode", async () => {
    const gpu = await init();
    try {
      const sceneScreen = surface(gpu, gpuCanvasLike(24, 16), { autoResize: false, depth: true, format: "rgba8unorm", msaa: true });
      const mesh = geometry(gpu, {
        buffers: [{
          data: new Float32Array([-0.7, -0.7, 0.7, -0.7, 0, 0.7]),
          attributes: { position: { format: "float32x2", location: 0 } },
        }],
      });
      const collection = instances({ capacity: 1 });
      collection.add();
      const bridge = instanceGeometry(gpu, collection, { mesh });
      expect(bridge.publish()).toBe(1);
      const scene = draw(gpu, { geometry: bridge.geometry, shader: prepareShader(INSTANCED), label: "surface-scene" });
      frame(gpu, (current) => current.pass(sceneScreen, (pass) => pass.draw(scene, { instances: 1 })));
      const scenePixel = pixelAt(await sceneScreen.color.read({ mipLevel: 0, region: "all" }), 24, 12, 8);
      expect(scenePixel[1]).toBeGreaterThan(160);
      expect(scenePixel[2]).toBeGreaterThan(240);

      const depthScreen = surface(gpu, gpuCanvasLike(24, 16), { autoResize: false, depth: true, format: "rgba8unorm" });
      const writeDepth = draw(gpu, { shader: prepareShader(FULLSCREEN_AT_DEPTH(0.25, [1, 0, 0])), label: "write-depth" });
      const inspectDepth = draw(gpu, {
        shader: prepareShader(READ_DEPTH_UNFILTERABLE),
        depth: false,
        label: "inspect-depth",
        set: { sceneDepth: depthScreen.depth! },
      });
      frame(gpu, (current) => {
        current.pass(depthScreen, writeDepth);
        current.pass({ target: depthScreen, clear: [0, 0, 0, 1], depthReadOnly: true }, inspectDepth);
      });
      const sampled = pixelAt(await depthScreen.color.read({ mipLevel: 0, region: "all" }), 24, 12, 8);
      expect(sampled[0]).toBeGreaterThan(55);
      expect(sampled[0]).toBeLessThan(75);
      expect(sampled[1]).toBeGreaterThan(180);
      expect(sampled[1]).toBeLessThan(200);
    } finally {
      gpu.dispose();
    }
  });

  test("combined depth/stencil renders and depth32float-stencil8 follows native feature enablement", async () => {
    const gpu = await init();
    try {
      const combined = surface(gpu, gpuCanvasLike(8, 8), {
        autoResize: false,
        depth: "depth24plus-stencil8",
        format: "rgba8unorm",
      });
      const marked = draw(gpu, {
        shader: prepareShader(FULLSCREEN_AT_DEPTH(0.5, [1, 1, 0])),
        stencil: { front: { compare: "always", pass: "replace" }, ref: 3 },
      });
      frame(gpu, (current) => current.pass({ target: combined, clearStencil: 0 }, marked));
      expect(pixelAt(await combined.color.read({ mipLevel: 0, region: "all" }), 8, 4, 4)).toEqual([255, 255, 0, 255]);
    } finally {
      gpu.dispose();
    }

    let featureGpu: Awaited<ReturnType<typeof init>>;
    try {
      featureGpu = await init({ requiredFeatures: ["depth32float-stencil8"] });
    } catch (error) {
      expect(error).toMatchObject({ code: "VGPU-FEATURE-UNSUPPORTED" });
      return;
    }
    try {
      const enabled = surface(featureGpu, gpuCanvasLike(4, 4), {
        autoResize: false,
        depth: "depth32float-stencil8",
        format: "rgba8unorm",
      });
      expect(enabled.depth?.format).toBe("depth32float-stencil8");
      frame(featureGpu, (current) => current.pass(enabled, effect(featureGpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`))));
    } finally {
      featureGpu.dispose();
    }
  });
});

function gpuCanvasLike(width: number, height: number): OffscreenCanvas {
  let configured: GPUCanvasConfiguration | undefined;
  let current: GPUTexture | undefined;
  let currentSize: readonly [number, number] | undefined;
  const canvas: Record<string, unknown> = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(descriptor: GPUCanvasConfiguration) {
          configured = descriptor;
          current = undefined;
          currentSize = undefined;
        },
        unconfigure() {
          current?.destroy();
          current = undefined;
          currentSize = undefined;
          configured = undefined;
        },
        getCurrentTexture() {
          if (!configured) throw new Error("Canvas context is not configured");
          const size = [canvas.width as number, canvas.height as number] as const;
          if (!current || !currentSize || size[0] !== currentSize[0] || size[1] !== currentSize[1]) {
            current?.destroy();
            current = configured.device.createTexture({
              size,
              format: configured.format,
              usage: configured.usage ?? (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC),
            });
            currentSize = size;
          }
          return current;
        },
      } as unknown as GPUCanvasContext;
    },
  };
  return canvas as unknown as OffscreenCanvas;
}

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

function partialRedPixels(pixels: Uint8Array): number {
  let partial = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset]! > 0 && pixels[offset]! < 255) partial += 1;
  }
  return partial;
}
