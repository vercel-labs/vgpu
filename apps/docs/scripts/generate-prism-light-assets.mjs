import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
  docsRoot,
  "assets/prism-light/wall-global-light-mask.png"
);
const output = resolve(
  docsRoot,
  "public/hero/prism-light/wall-global-light-mask.webp"
);

await mkdir(dirname(output), { recursive: true });
execFileSync(
  "cwebp",
  ["-quiet", "-q", "95", "-m", "6", source, "-o", output],
  { stdio: "inherit" }
);
process.stdout.write(`generated ${pathToFileURL(output).pathname}\n`);
