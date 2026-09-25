// Keeps tool-result images inside the model's image limits (5 MB per image counted on the base64
// payload, so ~3.7 MB of PNG) and the result limit, by halving the largest PNGs until they fit.
import pngjs from "pngjs";

const perImage = 2_500_000;
const perResult = 6_000_000;

/**
 * Returns `images` with oversized entries halved (2×2 box filter, repeatedly) so each stays under
 * ~2.5 MB and the set under ~6 MB. Files on disk keep full resolution; only the returned copies
 * shrink.
 *
 * @example
 *   const [small] = fitImages([hugePng]); // small.length < 2_500_000
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
