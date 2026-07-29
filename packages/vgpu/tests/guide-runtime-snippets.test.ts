import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { init, clock, effect, frame, sampler, surface, target } from "vgpu/mock";

const root = resolve(import.meta.dirname, "../../..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("getting-started TypeScript fences execute against vgpu/mock", async () => {
  const markdown = readFileSync(resolve(root, "docs/topics/getting-started.docs.md"), "utf8");
  const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);

  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    const executable = block
      .replace(/^import \{[^}]*\} from ["']vgpu(?:\/node)?["'];?\n/mu, "")
      .replace(/const canvas = document\.querySelector\(["']canvas["']\)!;/u, "const canvas = createMockCanvas();")
      // The mock has no animation frames: run the loop body once, as a plain frame.
      .replace(/frameLoop\(gpu, /gu, "frame(gpu, ");

    await new AsyncFunction("init", "createMockCanvas", "surface", "effect", "frame", "clock", `${executable}\ngpu.dispose();`)(init, createMockCanvas, surface, effect, frame, clock);
  }
});

test("corrected playbook and post-processing patterns run against vgpu/mock", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [64, 64] });
  const output = target(gpu, { size: [64, 64] });
  const wave = effect(gpu, `
    struct Params { time: f32, speed: f32 }
    @group(0) @binding(0) var<uniform> params: Params;
    @fragment fn fs_main() -> @location(0) vec4f {
      return vec4f(params.time * 0.0, params.speed * 0.0, 0.0, 1.0);
    }
  `, { set: { params: { time: 0, speed: 2 } } });
  const post = effect(gpu, `
    @group(0) @binding(0) var src: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return textureSampleLevel(src, samp, uv, 0.0);
    }
  `, { set: {
    src: colorTarget,
    samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
  } });

  wave.set({ params: { time: clock(gpu).time } });
  frame(gpu, (currentFrame) => {
    currentFrame.pass(colorTarget, wave);
    currentFrame.pass(output, post);
  });

  const canvasSurface = surface(gpu, createMockCanvas());
  const bloom = target(gpu, { size: [32, 32] });
  const bright = effect(gpu, `
    struct Params { resolution: vec2f }
    @group(0) @binding(0) var<uniform> params: Params;
    @fragment fn fs_main() -> @location(0) vec4f {
      return vec4f(params.resolution * 0.0, 0.0, 1.0);
    }
  `, { set: { params: { resolution: bloom.size } } });
  canvasSurface.onResize(({ width, height }) => {
    bloom.resize([width / 2, height / 2]);
    bright.set({ params: { resolution: bloom.size } });
  });
  frame(gpu, (currentFrame) => currentFrame.pass(bloom, bright));
  gpu.dispose();
});

function createMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        canvas,
        configure() {},
        unconfigure() {},
        getCurrentTexture() { return { createView: () => ({}) }; },
      };
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}
