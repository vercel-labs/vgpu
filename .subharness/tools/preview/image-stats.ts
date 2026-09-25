// Cheap pixel statistics that flag black or uniform captures, the usual sign of a failed WebGPU frame.
import pngjs from "pngjs";

export interface ImageStats {
  readonly meanLuma: number;
  readonly lumaStdDev: number;
  readonly uniform: boolean;
}

/**
 * Samples every 4th pixel of a PNG and reports mean and standard deviation of Rec. 709 luma
 * (0–255). `uniform` is true below a standard deviation of 2, which a real scene never reaches.
 *
 * @example
 *   imageStats(await readFile("shot.png")); // { meanLuma: 41.2, lumaStdDev: 37.9, uniform: false }
 */
export function imageStats(png: Buffer): ImageStats {
  const { data, width, height } = pngjs.PNG.sync.read(png);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < width * height; index += 4) {
    const offset = index * 4;
    const luma = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
    sum += luma;
    sumSquares += luma * luma;
    count++;
  }
  const meanLuma = sum / count;
  const lumaStdDev = Math.sqrt(Math.max(0, sumSquares / count - meanLuma * meanLuma));
  return { meanLuma: round(meanLuma), lumaStdDev: round(lumaStdDev), uniform: lumaStdDev < 2 };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
