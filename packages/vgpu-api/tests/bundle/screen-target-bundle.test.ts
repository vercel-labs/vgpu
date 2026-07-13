import { expect, test } from "vitest";
import { init as initBrowser } from "../../src/index.ts";
import { createMockAdapter } from "../../src/mock.ts";

const SOLID = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}
`;

test("screen-target bundles do not stale just because getCurrentTexture returns a fresh wrapper", async () => {
  const gpu = await initBrowser(mockCanvas(), { adapter: createMockAdapter(), size: [4, 4] });
  const draw = gpu.pass(SOLID, { label: "screenStatic" });

  const bundle = gpu.bundle({ target: gpu.screen!, label: "screenBundle" }, (b) => b.draw(draw));

  expect(() => gpu.frame((frame) => frame.pass({ target: gpu.screen! }, (p) => p.bundles(bundle)))).not.toThrow();
  expect(() => gpu.frame((frame) => frame.pass({ target: gpu.screen! }, (p) => p.bundles(bundle)))).not.toThrow();
  gpu.dispose();
});

function mockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        canvas,
        configure() {},
        getCurrentTexture() {
          return { createView: () => ({}) };
        },
      };
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}
