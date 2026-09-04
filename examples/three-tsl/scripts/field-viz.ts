// Field visualizer: renders lava.wgsl's exported fields to PNGs using pure
// vgpu/node — no three involved. Use it to inspect and tune internal fields
// (heat through the blackbody ramp, melt mask, striations, crust height)
// on the same 2D slice the plane demo shows.
//
//   pnpm --filter @vgpu/example-three-tsl field-viz [heat|melt|skin|crust ...]
//
// Needs the same Vulkan ICD environment as generate-previews.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { init } from "vgpu/node";
import { PNG } from "pngjs";

const SIZE = 640;
const FRAME_TIME = 8;
const EXAMPLE_DIR = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = `${EXAMPLE_DIR}field-viz/`;

const MODES: Record<string, number> = { heat: 0, melt: 1, skin: 2, crust: 3 };

const VIZ_ENTRY = `${OUT_DIR}entry.wgsl`;
const VIZ_SOURCE = /* wgsl */ `
import { lavaGlow, meltSkin, blackbody, crustHeight } from "../src/lava.wgsl";

struct Params { mode: f32, t: f32, span: f32, center: vec2f }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Same slice the plane demo samples: local XY in [-span/2, span/2], z = 0.
  let p = vec3f((uv.x - 0.5) * params.span + params.center.x, (0.5 - uv.y) * params.span + params.center.y, 0.0);
  if (params.mode < 0.5) {
    let glow = lavaGlow(p, params.t);
    return vec4f(blackbody(glow.x), 1.0);
  } else if (params.mode < 1.5) {
    let melt = lavaGlow(p, params.t).y;
    return vec4f(melt, melt, melt, 1.0);
  } else if (params.mode < 2.5) {
    let skinValue = meltSkin(p, params.t);
    return vec4f(skinValue, skinValue, skinValue, 1.0);
  }
  let height = crustHeight(p, params.t);
  return vec4f(height, height, height, 1.0);
}
`;

const args = process.argv.slice(2);
const fields = args.filter((name) => name in MODES);
const selected = fields.length > 0 ? fields : Object.keys(MODES);
// Optional zoom: span=<world units across the image> (default 4.4, the
// plane demo's width) and center=<x,y> to look at a specific spot.
const span = Number(args.find((a) => a.startsWith("span="))?.slice(5) ?? "4.4");
const center = (args.find((a) => a.startsWith("center="))?.slice(7) ?? "0,0").split(",").map(Number);

// The entry is written to disk so imports resolve against the real files.
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(VIZ_ENTRY, VIZ_SOURCE);
const resolved = await resolveShader({ entry: VIZ_ENTRY });

const gpu = await init();
const target = gpu.target({ size: [SIZE, SIZE], format: "rgba8unorm" });
mkdirSync(OUT_DIR, { recursive: true });

for (const name of selected) {
  const effect = gpu.effect({ version: 1, wgsl: resolved.wgsl }, { set: { params: { mode: MODES[name]!, t: FRAME_TIME, span, center } } });
  effect.draw(target);
  const pixels = new Uint8Array(await target.read());
  const png = new PNG({ width: SIZE, height: SIZE });
  png.data.set(pixels);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const file = `${OUT_DIR}${name}.png`;
  writeFileSync(file, PNG.sync.write(png));
  console.log(`wrote ${file}`);
}

gpu.dispose();
