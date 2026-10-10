import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { bundle, effect, frame, init, surface } from "../../src/node.ts";

const RED = `
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("Surface signature Docker GPU acceptance", () => {
  test("prepares before the first frame and replays after resize on the current canvas image", async () => {
    const gpu = await init();
    try {
      const canvas = gpuCanvasLike(8, 8);
      const screen = surface(gpu, canvas.canvas, { autoResize: false, label: "signatureSurface" });
      const red = effect(gpu, prepareShader(RED), { label: "signatureRed" });

      await expect(red.compile(screen)).resolves.toBe(red);
      const recorded = bundle(gpu, { target: screen, label: "signatureBundle" }, (recorder) => recorder.draw(red));
      expect(canvas.acquisitions()).toBe(0);

      frame(gpu, (currentFrame) => currentFrame.pass(screen, (pass) => pass.bundles(recorded)));
      expect(canvas.acquisitions()).toBe(1);
      const initial = await screen.color.read({ mipLevel: 0, region: "all" });
      // The color wrapper acquires the texture, then readback verifies its current identity.
      expect(canvas.acquisitions()).toBe(3);
      expect(rgbaAt(initial, 8, 4, 4)).toEqual([255, 0, 0, 255]);

      screen.resize([12, 4]);
      frame(gpu, (currentFrame) => currentFrame.pass(screen, (pass) => pass.bundles(recorded)));
      expect(canvas.acquisitions()).toBe(4);
      const resized = await screen.color.read({ mipLevel: 0, region: "all" });
      expect(canvas.acquisitions()).toBe(6);
      expect(resized.byteLength).toBe(12 * 4 * 4);
      expect(rgbaAt(resized, 12, 6, 2)).toEqual([255, 0, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });
});

function gpuCanvasLike(width: number, height: number) {
  let configured: GPUCanvasConfiguration | undefined;
  let current: GPUTexture | undefined;
  let currentSize: readonly [number, number] | undefined;
  let acquisitionCount = 0;
  const canvas: Record<string, unknown> = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(desc: GPUCanvasConfiguration) {
          configured = desc;
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
          acquisitionCount += 1;
          if (!configured) throw new Error("Canvas context is not configured");
          const nextSize = [canvas.width as number, canvas.height as number] as const;
          if (!current || !currentSize || currentSize[0] !== nextSize[0] || currentSize[1] !== nextSize[1]) {
            current?.destroy();
            current = configured.device.createTexture({
              size: nextSize,
              format: configured.format,
              usage: configured.usage ?? defaultCanvasUsage(),
            });
            currentSize = nextSize;
          }
          return current;
        },
      } as unknown as GPUCanvasContext;
    },
  };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    acquisitions: () => acquisitionCount,
  };
}

function defaultCanvasUsage(): GPUTextureUsageFlags {
  return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
}

function rgbaAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}
