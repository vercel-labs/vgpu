import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { effect, init, target } from "vgpu/node";

// Renders a 64x64 image and writes it to out.png.
const SHADER = /* wgsl */ `
  @fragment fn main() -> @location(0) vec4f {
    return vec4f(0.25, 0.5, 0.75, 1.0);
  }
`;

const width = 64;
const height = 64;

const gpu = await init();
const colorTarget = target(gpu, { size: [width, height] });
effect(gpu, SHADER).draw(colorTarget);
const pixels = await colorTarget.read();

const png = new PNG({ width, height });
png.data.set(pixels);
writeFileSync("out.png", PNG.sync.write(png));
gpu.dispose();
