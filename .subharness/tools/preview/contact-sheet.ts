// Packs a burst of equally sized PNG frames into one grid image, so an animation strip costs a
// single image slot in the tool result.
import pngjs from "pngjs";

const gap = 4;

/**
 * Lays `frames` out left-to-right, top-to-bottom in `columns`, separated by a dark gutter. Frames
 * must share one size (they come from the same clip and scale).
 *
 * @example
 *   const sheet = contactSheet([pngA, pngB, pngC, pngD], 2); // 2×2 grid PNG
 */
export function contactSheet(frames: readonly Buffer[], columns: number): Buffer {
  const images = frames.map((frame) => pngjs.PNG.sync.read(frame));
  const width = images[0].width;
  const height = images[0].height;
  const rows = Math.ceil(images.length / columns);
  const sheet = new pngjs.PNG({ width: columns * width + (columns - 1) * gap, height: rows * height + (rows - 1) * gap });
  sheet.data.fill(0);
  for (let index = 3; index < sheet.data.length; index += 4) sheet.data[index] = 255;
  images.forEach((image, index) => {
    const left = (index % columns) * (width + gap);
    const top = Math.floor(index / columns) * (height + gap);
    for (let y = 0; y < Math.min(height, image.height); y++) {
      const source = y * image.width * 4;
      image.data.copy(sheet.data, ((top + y) * sheet.width + left) * 4, source, source + Math.min(width, image.width) * 4);
    }
  });
  return pngjs.PNG.sync.write(sheet);
}
