import type { GeneratedLightAsset } from "./types";

const EDGE_FADE = 0.06;

export function applyGlobalLightMask(
  asset: GeneratedLightAsset,
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number
): void {
  for (let y = 0; y < asset.height; y++) {
    const sourceY = ((y + 0.5) / asset.height) * sourceHeight - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const mixY = sourceY - Math.floor(sourceY);
    for (let x = 0; x < asset.width; x++) {
      const sourceX = ((x + 0.5) / asset.width) * sourceWidth - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const mixX = sourceX - Math.floor(sourceX);
      const top =
        source[(y0 * sourceWidth + x0) * 4]! * (1 - mixX) +
        source[(y0 * sourceWidth + x1) * 4]! * mixX;
      const bottom =
        source[(y1 * sourceWidth + x0) * 4]! * (1 - mixX) +
        source[(y1 * sourceWidth + x1) * 4]! * mixX;
      const u = (x + 0.5) / asset.width;
      const v = (y + 0.5) / asset.height;
      const edgeDistance = Math.min(u, 1 - u, v, 1 - v);
      const edgeFade = smoothstep(0, EDGE_FADE, edgeDistance);
      asset.pixels[(y * asset.width + x) * 4] = Math.round(
        (top * (1 - mixY) + bottom * mixY) * edgeFade
      );
    }
  }
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

export function globalLightMaskEdgeMax(
  pixels: Uint8Array,
  width: number,
  height: number,
  inset: number
): number {
  let result = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        x >= inset &&
        x < width - inset &&
        y >= inset &&
        y < height - inset
      )
        continue;
      result = Math.max(result, pixels[(y * width + x) * 4]!);
    }
  }
  return result;
}
