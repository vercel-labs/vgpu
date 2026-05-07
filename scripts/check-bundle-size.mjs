import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { createGzip } from "node:zlib";

const root = process.cwd();
const packagesDir = join(root, "packages");
let failed = false;

for (const name of await readdir(packagesDir)) {
  const dir = join(packagesDir, name);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (pkg.vgpuExportBundleBudgetsGzipBytes) await checkExportBudgets(dir, pkg);
  else if (pkg.vgpuBundleBudgetGzipBytes) await checkPackageBudget(dir, pkg);
}

if (failed) process.exit(1);

async function checkExportBudgets(dir, pkg) {
  for (const [subpath, budget] of Object.entries(pkg.vgpuExportBundleBudgetsGzipBytes)) {
    const exportInfo = pkg.exports?.[subpath];
    const jsFile = typeof exportInfo === "object" ? exportInfo.import : exportInfo;
    const path = join(dir, jsFile.replace(/^\.\//, ""));
    const gzipBytes = existsSync(path) ? await bundledGzipSize(path) : Infinity;
    console.log(`${pkg.name}${subpath === "." ? "" : subpath.slice(1)}: ${gzipBytes} B gzip / ${budget} B budget`);
    if (gzipBytes > budget) failed = true;
  }
}

async function bundledGzipSize(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*", "webgpu", "@vgpu/*"],
    write: false,
    minify: true,
    mainFields: ["module", "main"],
  });
  return gzipBytes(result.outputFiles[0].contents);
}

async function checkPackageBudget(dir, pkg) {
  execFileSync("pnpm", ["--dir", dir, "pack", "--pack-destination", dir], { stdio: "ignore" });
  const tarball = join(dir, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
  const bytes = await gzipSize(tarball);
  rmSync(tarball, { force: true });
  console.log(`${pkg.name}: ${bytes} B gzip / ${pkg.vgpuBundleBudgetGzipBytes} B budget`);
  if (bytes > pkg.vgpuBundleBudgetGzipBytes) failed = true;
}

function gzipSize(path) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    createReadStream(path).pipe(createGzip()).on("data", (chunk) => { bytes += chunk.length; }).on("end", () => resolve(bytes)).on("error", reject);
  });
}

function gzipBytes(contents) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const gzip = createGzip();
    gzip.on("data", (chunk) => { bytes += chunk.length; }).on("end", () => resolve(bytes)).on("error", reject);
    gzip.end(contents);
  });
}
