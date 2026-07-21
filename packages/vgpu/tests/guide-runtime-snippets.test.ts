import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { init } from "vgpu/mock";

const root = resolve(import.meta.dirname, "../../..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("getting-started TypeScript fences execute against vgpu/mock", async () => {
  const markdown = readFileSync(resolve(root, "docs/topics/getting-started.docs.md"), "utf8");
  const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);

  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    const executable = block
      .replace(/^import \{ init \} from ["']vgpu["'];?\n/mu, "")
      .replace(/const canvas = document\.querySelector\(["']canvas["']\)!;/u, "const canvas = createMockCanvas();")
      .replace(/gpu\.frame\.loop\(/gu, "gpu.frame(");

    await new AsyncFunction("init", "createMockCanvas", `${executable}\ngpu.dispose();`)(init, createMockCanvas);
  }
});

test("corrected playbook and post-processing patterns run against vgpu/mock", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [64, 64] });
  const output = gpu.target({ size: [64, 64] });
  const wave = gpu.effect(`
    struct Params { time: f32, speed: f32 }
    @group(0) @binding(0) var<uniform> params: Params;
    @fragment fn fs_main() -> @location(0) vec4f {
      return vec4f(params.time * 0.0, params.speed * 0.0, 0.0, 1.0);
    }
  `, { set: { params: { time: 0, speed: 2 } } });
  const post = gpu.effect(`
    @group(0) @binding(0) var src: texture_2d<f32>;
    @group(0) @binding(1) var samp: sampler;
    @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return textureSampleLevel(src, samp, uv, 0.0);
    }
  `, { set: {
    src: target,
    samp: gpu.sampler({ minFilter: "linear", magFilter: "linear" }),
  } });

  wave.set({ params: { time: gpu.time } });
  gpu.frame((frame) => {
    frame.pass(target, wave);
    frame.pass(output, post);
  });

  const surface = gpu.surface(createMockCanvas());
  const bloom = gpu.target({ size: [32, 32] });
  const bright = gpu.effect(`
    struct Params { resolution: vec2f }
    @group(0) @binding(0) var<uniform> params: Params;
    @fragment fn fs_main() -> @location(0) vec4f {
      return vec4f(params.resolution * 0.0, 0.0, 1.0);
    }
  `, { set: { params: { resolution: bloom.size } } });
  surface.onResize(({ width, height }) => {
    bloom.resize([width / 2, height / 2]);
    bright.set({ params: { resolution: bloom.size } });
  });
  gpu.frame((frame) => frame.pass(bloom, bright));
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
