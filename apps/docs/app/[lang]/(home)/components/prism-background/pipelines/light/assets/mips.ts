import type { GeneratedLightAsset } from "./types";

export function generateMipChain(
  base: GeneratedLightAsset
): GeneratedLightAsset[] {
  const levels = [base];
  let current = base;
  while (current.width > 1 || current.height > 1) {
    const width = Math.max(1, current.width >> 1);
    const height = Math.max(1, current.height >> 1);
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let channel = 0; channel < 4; channel++) {
          let sum = 0;
          for (let oy = 0; oy < 2; oy++) {
            for (let ox = 0; ox < 2; ox++) {
              const sourceX = Math.min(current.width - 1, x * 2 + ox);
              const sourceY = Math.min(current.height - 1, y * 2 + oy);
              sum +=
                current.pixels[
                  (sourceY * current.width + sourceX) * 4 + channel
                ]!;
            }
          }
          pixels[(y * width + x) * 4 + channel] = Math.round(sum / 4);
        }
      }
    }
    current = { width, height, pixels };
    levels.push(current);
  }
  return levels;
}
