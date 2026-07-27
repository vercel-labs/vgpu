import { init } from "vgpu/node";
import { autonomousLight } from "./flare/animation.ts";
import { FlareRenderer } from "./flare/renderer.ts";
import { DEFAULT_FLARE_SETTINGS, flarePlacement } from "./flare/settings.ts";
import {
  LOGO_RASTER_HEIGHT,
  LOGO_RASTER_WIDTH,
  logoRasterRgba,
} from "./assets/logo-raster.ts";

// The vercel.com /frameworks/nextjs hero preview framing: a wide canvas with
// the N glyph anchored at two thirds, captured mid-orbit with the light pulse
// fully on.
export const CANVAS: readonly [number, number] = [1512, 436];
export const LOGO_CENTER: readonly [number, number] = [0.6666667, 0.5];
export const TIME_SECONDS = 4.2;

export async function runNextjsFlareExample() {
  const gpu = await init();
  const target = gpu.target({ size: CANVAS, format: "rgba8unorm" });
  const renderer = new FlareRenderer(gpu, target, DEFAULT_FLARE_SETTINGS);
  await renderer.resize(CANVAS);
  // The reference size is the virtual square the glyph box is measured
  // against; the embedded raster was baked at exactly this size.
  const placement = flarePlacement(CANVAS[0], CANVAS[1], CANVAS[1], LOGO_CENTER);
  renderer.setPlacement(placement);
  renderer.uploadLogoRgba(logoRasterRgba(), LOGO_RASTER_WIDTH, LOGO_RASTER_HEIGHT);
  // The autonomous orbit is expressed in logo-local units; map it into
  // canvas UV space around the logo center.
  const local = autonomousLight(TIME_SECONDS);
  const light: readonly [number, number] = [
    placement.logoCenter[0] + (local[0] - 0.5) / placement.canvasToLogo[0],
    placement.logoCenter[1] + (local[1] - 0.5) / placement.canvasToLogo[1],
  ];
  renderer.render(TIME_SECONDS, light);
  await renderer.settled();
  return { gpu, renderer, target };
}

// `pnpm dev` renders one frame and writes a viewable flare.ppm next to the
// example (P6 is dependency-free; convert with any image tool).
const entry = process.argv[1];
if (entry && import.meta.url === new URL(`file://${entry}`).href) {
  const { gpu, renderer, target } = await runNextjsFlareExample();
  try {
    const rgba = await target.read();
    const { writeFile } = await import("node:fs/promises");
    const header = `P6\n${CANVAS[0]} ${CANVAS[1]}\n255\n`;
    const rgb = new Uint8Array(CANVAS[0] * CANVAS[1] * 3);
    for (let i = 0; i < CANVAS[0] * CANVAS[1]; i += 1) {
      rgb[i * 3] = rgba[i * 4] ?? 0;
      rgb[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
      rgb[i * 3 + 2] = rgba[i * 4 + 2] ?? 0;
    }
    const out = new URL("../flare.ppm", import.meta.url);
    await writeFile(out, Buffer.concat([Buffer.from(header), Buffer.from(rgb)]));
    console.log(`wrote ${out.pathname} (${CANVAS[0]}x${CANVAS[1]})`);
  } finally {
    renderer.dispose();
    gpu.dispose();
  }
}
