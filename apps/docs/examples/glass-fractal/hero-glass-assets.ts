import type { Gpu } from "vgpu";

import {
  createHeroGlassAssets,
  type HeroGlassAssets,
} from "./hero-glass-assets-core";
export type { HeroGlassAssets } from "./hero-glass-assets-core";

const GLASS_MESH_URL =
  "/examples/glass-fractal/rounded-tetrahedron.mesh?v=bevel-4";
const FRACTAL_MESH_URL =
  "/examples/glass-fractal/fractal-tetrahedron-l7.mesh?v=sphere-anchor-2";
const ENVIRONMENT_URL =
  "/examples/glass-fractal/studio-cubemap-prefiltered.png?v=studio-panels-2";

/** Browser asset adapter: fetch + createImageBitmap, with GPU decoding shared with Node. */
export async function loadHeroGlassAssets(
  gpu: Gpu,
  signal?: AbortSignal
): Promise<HeroGlassAssets> {
  const [glassResponse, fractalResponse, environmentResponse] =
    await Promise.all([
      fetch(GLASS_MESH_URL, { signal }),
      fetch(FRACTAL_MESH_URL, { signal }),
      fetch(ENVIRONMENT_URL, { signal }),
    ]);
  for (const [response, url] of [
    [glassResponse, GLASS_MESH_URL],
    [fractalResponse, FRACTAL_MESH_URL],
    [environmentResponse, ENVIRONMENT_URL],
  ] as const) {
    if (!response.ok)
      throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  const [glassBuffer, fractalBuffer, environmentBlob] = await Promise.all([
    glassResponse.arrayBuffer(),
    fractalResponse.arrayBuffer(),
    environmentResponse.blob(),
  ]);
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(environmentBlob);
  try {
    signal?.throwIfAborted();
    const canvas = createPixelCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("Could not decode the hero cubemap atlas.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    signal?.throwIfAborted();
    return createHeroGlassAssets(gpu, glassBuffer, fractalBuffer, {
      width: bitmap.width,
      height: bitmap.height,
      data: pixels,
    });
  } finally {
    bitmap.close();
  }
}

function createPixelCanvas(
  width: number,
  height: number
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
