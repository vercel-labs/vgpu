// Usage: pnpm build && node scripts/bench-draw-encode.mjs --entry <label>=<abs path to vgpu dist/mock.js> [--entry ...] [--runs 5] [--json] [--max-us <n>]
// Issue #489 workload: N (default 2000) persistent draws with three identity-bound uniform Buffers,
// 3 passes per frame, 5 warm-up then 20 timed frames; only frame encoding is timed. Each run is a
// fresh child process and entries alternate (A, B, A, B, ...) so machine drift hits every entry alike.
import { execFileSync, spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);

if (args[0] === "--child") {
  console.log(JSON.stringify({ usPerDraw: await measure(args[1]) }));
} else {
  await main();
}

async function measure(entry) {
  const { init, draw, target, frame, geometry } = await import(pathToFileURL(entry).href);
  const { prepareShader } = await import(new URL("../packages/wgsl/dist/prepare.js", import.meta.url).href);
  const gpu = await init();
  const shader = prepareShader(`struct Frame { viewProjection: mat4x4f }
struct Object { world: mat4x4f }
struct Material { color: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: Object;
@group(2) @binding(0) var<uniform> material: Material;
@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f { return frame.viewProjection * object.world * vec4f(position, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return material.color; }`, "encode.wgsl");
  const buffer = (size) => gpu.device.createBuffer({ size, usage: ["uniform", "copy_dst"] });
  const frameBuffer = buffer(64);
  const materialBuffer = buffer(16);
  const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(9), stride: 12, attributes: { position: { format: "float32x3", offset: 0, location: 0 } } }], vertexCount: 3 });
  const out = target(gpu, { size: [8, 8], depth: true });
  const count = Number(process.env.N ?? 2000);
  const draws = Array.from({ length: count }, () => draw(gpu, { shader, geometry: mesh, set: { frame: frameBuffer, object: buffer(64), material: materialBuffer } }));
  const run = () => frame(gpu, (f) => { for (let pass = 0; pass < 3; pass++) f.pass({ target: out }, (p) => { for (const item of draws) p.draw(item); }); });
  for (let index = 0; index < 5; index++) { run(); await gpu.settled(); }
  let encode = 0;
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    run();
    encode += performance.now() - start;
    await gpu.settled();
  }
  gpu.dispose();
  return (encode / 20) * 1000 / (count * 3);
}

async function main() {
  const entries = [];
  let runs = 5;
  let json = false;
  let maxUs;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--entry") {
      const value = args[++index] ?? "";
      const split = value.indexOf("=");
      if (split <= 0) throw new Error(`--entry expects <label>=<path>, received ${value}`);
      entries.push({ label: value.slice(0, split), path: value.slice(split + 1), samples: [] });
    } else if (arg === "--runs") runs = Number(args[++index]);
    else if (arg === "--json") json = true;
    else if (arg === "--max-us") maxUs = Number(args[++index]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!entries.length) throw new Error("Pass at least one --entry <label>=<path to dist/mock.js>");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs expects a positive integer");

  const script = fileURLToPath(import.meta.url);
  for (let run = 0; run < runs; run++) {
    for (const entry of entries) {
      const child = spawnSync(process.execPath, [script, "--child", entry.path], { encoding: "utf8", env: process.env });
      if (child.status !== 0) throw new Error(`${entry.label} run ${run + 1} failed:\n${child.stderr}`);
      entry.samples.push(JSON.parse(child.stdout.trim().split("\n").at(-1)).usPerDraw);
    }
  }

  const summary = entries.map(({ label, path, samples }) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { label, path, samples, median, min: sorted[0], max: sorted.at(-1) };
  });
  const environment = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    revision: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    draws: Number(process.env.N ?? 2000),
    runs,
  };
  if (json) console.log(JSON.stringify({ environment, entries: summary }, null, 2));
  else {
    console.log(`node ${environment.node} · ${environment.platform} · ${environment.cpu}`);
    console.log(`revision ${environment.revision}${environment.dirty ? " (dirty)" : ""} · ${environment.draws} draws × 3 passes · ${runs} runs per entry`);
    for (const { label, samples, median, min, max } of summary) {
      console.log(`${label}: median ${median.toFixed(2)} µs/draw (min ${min.toFixed(2)}, max ${max.toFixed(2)}) runs ${samples.map((value) => value.toFixed(2)).join(", ")}`);
    }
  }
  const last = summary.at(-1);
  if (maxUs !== undefined && last.median > maxUs) {
    console.error(`${last.label} median ${last.median.toFixed(2)} µs/draw exceeds --max-us ${maxUs}`);
    process.exitCode = 1;
  }
}

function git(command) {
  try { return execFileSync("git", command, { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}
