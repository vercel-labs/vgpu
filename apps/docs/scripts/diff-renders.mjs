// Pixel difference between two directories of same-named PNGs.
//   node scripts/diff-renders.mjs <before-dir> <after-dir>
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const [beforeDir, afterDir] = process.argv.slice(2).map((p) => path.resolve(p));
if (!beforeDir || !afterDir) throw new Error('usage: diff-renders.mjs <before-dir> <after-dir>');

const names = (await readdir(beforeDir)).filter((n) => n.endsWith('.png')).sort();
let totalMean = 0;
let totalMax = 0;
let totalRatio = 0;
for (const name of names) {
  const a = PNG.sync.read(await readFile(path.join(beforeDir, name)));
  const b = PNG.sync.read(await readFile(path.join(afterDir, name)));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${name}: size mismatch`);
  let sum = 0;
  let max = 0;
  let over = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < pixels; i++) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]);
      sum += d;
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax > max) max = pixelMax;
    if (pixelMax > 2) over++;
  }
  const mean = sum / (pixels * 3);
  const ratio = over / pixels;
  totalMean += mean; totalMax = Math.max(totalMax, max); totalRatio += ratio;
  console.log(`- ${name}: mean=${mean.toFixed(3)} max=${max} pixels>2=${(ratio * 100).toFixed(3)}%`);
}
console.log(`= all: mean=${(totalMean / names.length).toFixed(3)} max=${totalMax} pixels>2=${(totalRatio / names.length * 100).toFixed(3)}%`);
