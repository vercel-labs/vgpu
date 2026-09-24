// Command-line entry to the preview capture used by the example-builder tool, for leads and humans.
//
//   node .subharness/tools/preview/cli.ts <slug> [--steps '<json array>' | --steps @steps.json]
//     [--width 1280] [--height 720] [--dpr 1] [--touch] [--settle 2500] [--path /examples/<slug>]
//     [--wait-for canvas] [--reduced-motion]
//
// Prints the capture summary as JSON; PNGs land in .context/shots/<slug>/.
import { readFile } from "node:fs/promises";
import { capturePreview, type CaptureStep } from "./capture.ts";

const booleanFlags = new Set(["reduced-motion", "touch"]);
const [slug, ...rest] = process.argv.slice(2);
if (!slug || slug.startsWith("--")) {
  console.error("usage: node .subharness/tools/preview/cli.ts <slug> [--steps <json|@file>] [--width n] [--height n] [--dpr n] [--touch] [--settle ms] [--path p] [--wait-for sel] [--reduced-motion]");
  process.exit(2);
}
const flags = new Map<string, string>();
for (let index = 0; index < rest.length; index++) {
  const name = rest[index].replace(/^--/, "");
  if (booleanFlags.has(name)) flags.set(name, "true");
  else flags.set(name, rest[++index] ?? "");
}
const stepsFlag = flags.get("steps");
const steps = stepsFlag
  ? JSON.parse(stepsFlag.startsWith("@") ? await readFile(stepsFlag.slice(1), "utf8") : stepsFlag) as CaptureStep[]
  : [];

const result = await capturePreview({
  root: process.cwd(),
  slug,
  path: flags.get("path"),
  width: Number(flags.get("width") ?? 1280),
  height: Number(flags.get("height") ?? 720),
  dpr: Number(flags.get("dpr") ?? 1),
  touch: flags.has("touch"),
  settleMs: Number(flags.get("settle") ?? 2500),
  waitFor: flags.get("wait-for") ?? "canvas",
  reducedMotion: flags.has("reduced-motion"),
  steps,
});
console.log(JSON.stringify({ ...result, shots: result.shots.map(({ png: _png, ...shot }) => shot) }, null, 2));
