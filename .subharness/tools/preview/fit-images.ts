// Keeps tool-result images inside the transport limits (5 MiB per image, 8 MiB per result) by
// halving the largest PNGs until everything fits.
import pngjs from "pngjs";

const perImage = 4_500_000;
const perResult = 7_000_000;

/**
 * Returns `images` with oversized entries halved (2×2 box filter, repeatedly) so each stays under
 * ~4.5 MB and the set under ~7 MB. Files on disk keep full resolution; only the returned copies
 * shrink.
 *
 * @example
 *   const [small] = fitImages([hugePng]); // small.length < 4_500_000
 */
export function fitImages(images: readonly Buffer[]): Buffer[] {
  const fitted = images.map((image) => shrinkUntil(image, perImage));
  let total = fitted.reduce((sum, image) => sum + image.length, 0);
  while (total > perResult) {
    const largest = fitted.reduce((best, image, index) => (image.length > fitted[best].length ? index : best), 0);
    const smaller = halve(fitted[largest]);
    if (smaller.length >= fitted[largest].length) break;
    total -= fitted[largest].length - smaller.length;
    fitted[largest] = smaller;
  }
  return fitted;
}

function shrinkUntil(image: Buffer, limit: number): Buffer {
  let current = image;
  while (current.length > limit) {
    const smaller = halve(current);
    if (smaller.length >= current.length) break;
    current = smaller;
  }
  return current;
}

function halve(png: Buffer): Buffer {
  const source = pngjs.PNG.sync.read(png);
  const width = Math.max(1, Math.floor(source.width / 2));
  const height = Math.max(1, Math.floor(source.height / 2));
  const target = new pngjs.PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += source.data[((y * 2 + dy) * source.width + (x * 2 + dx)) * 4 + channel];
          }
        }
        target.data[(y * width + x) * 4 + channel] = sum / 4;
      }
    }
  }
  return pngjs.PNG.sync.write(target);
}
