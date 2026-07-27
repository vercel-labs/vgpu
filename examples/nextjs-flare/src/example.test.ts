import { expect, test } from "vitest";
import { CANVAS, LOGO_CENTER, runNextjsFlareExample, TIME_SECONDS } from "./example.ts";
import { autonomousLight, lightPulse } from "./flare/animation.ts";
import { gaussianBlurKernel } from "./flare/blur-kernel.ts";
import { logoPixelSize } from "./flare/settings.ts";
import {
  blurShader,
  compositeShader,
  logoShader,
  rimShader,
} from "./flare/shaders.ts";
import {
  LOGO_RASTER_HEIGHT,
  LOGO_RASTER_REFERENCE_SIZE,
  LOGO_RASTER_WIDTH,
  logoRasterRgba,
} from "./assets/logo-raster.ts";

test("nextjs-flare keeps the marketing shader passes intact", () => {
  // 48-step volumetric ray walk with blue-noise jitter.
  expect(compositeShader).toContain("for (var i = 0; i < 48; i++)");
  expect(compositeShader).toContain("resolveDarkColor");
  expect(compositeShader).toContain("blueNoiseTexture");
  // Squared rim base steepens the SVG gradient falloff.
  expect(rimShader).toContain("(sharp * sharp) * present");
  expect(logoShader).toContain("textureSample(logoTexture, logoSampler, sampleUv)");
  expect(blurShader).toContain("const MAX_TAPS: u32 = 8u");
});

test("embedded logo raster matches the derived logo pixel size", () => {
  const [width, height] = logoPixelSize(LOGO_RASTER_REFERENCE_SIZE, 1);
  const pad = 3;
  expect(LOGO_RASTER_WIDTH).toBe(width + pad * 2);
  expect(LOGO_RASTER_HEIGHT).toBe(height + pad * 2);
  const rgba = logoRasterRgba();
  expect(rgba.length).toBe(LOGO_RASTER_WIDTH * LOGO_RASTER_HEIGHT * 4);
  // The glyph strokes must be present (non-empty alpha coverage).
  let covered = 0;
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 0) > 0) covered += 1;
  expect(covered).toBeGreaterThan(1000);
});

test("the example frame samples the light fully on inside the fade range", () => {
  // t=4.2 sits inside the pinned first 6s hold of the breathing pulse.
  expect(lightPulse(TIME_SECONDS)).toBe(1);
  // The orbit position stays within the attenuation fade range so the
  // rendered frame is a lit one.
  const [x, y] = autonomousLight(TIME_SECONDS);
  expect(Math.abs(x - 0.5)).toBeLessThan(0.6);
  expect(Math.abs(y - 0.5)).toBeLessThan(0.6);
  // The dark rim blur uses the approved sigma-5 kernel (8 symmetric taps max).
  expect(gaussianBlurKernel(5).taps.length).toBeLessThanOrEqual(8);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")(
  "nextjs-flare renders the dark hero frame",
  async () => {
    const { gpu, renderer, target } = await runNextjsFlareExample();
    try {
      const pixels = await target.read();
      const sample = (u: number, v: number) => {
        const x = Math.min(CANVAS[0] - 1, Math.round(u * CANVAS[0]));
        const y = Math.min(CANVAS[1] - 1, Math.round(v * CANVAS[1]));
        const offset = (y * CANVAS[0] + x) * 4;
        return [
          pixels[offset] ?? 0,
          pixels[offset + 1] ?? 0,
          pixels[offset + 2] ?? 0,
          pixels[offset + 3] ?? 0,
        ] as const;
      };
      // The edge fade pins the frame borders to the pure black background.
      expect(sample(0, 0).slice(0, 3)).toEqual([0, 0, 0]);
      expect(sample(0.999, 0.999).slice(0, 3)).toEqual([0, 0, 0]);
      // The glyph area glows in the #b3bfff family: bright and blue-leaning.
      const [r, g, b] = sample(LOGO_CENTER[0], LOGO_CENTER[1]);
      const brightness = Math.max(r, g, b);
      expect(brightness).toBeGreaterThan(8);
      expect(b).toBeGreaterThanOrEqual(r);
      // Somewhere in the frame the flare is clearly lit.
      let peak = 0;
      for (let i = 0; i < pixels.length; i += 4)
        peak = Math.max(peak, pixels[i + 2] ?? 0);
      expect(peak).toBeGreaterThan(100);
    } finally {
      renderer.dispose();
      gpu.dispose();
    }
  },
);
