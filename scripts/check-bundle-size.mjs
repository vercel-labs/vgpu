import { execFileSync } from "node:child_process";
import { createReadStream, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGzip } from "node:zlib";

const root = process.cwd();
const packagesDir = join(root, "packages");
let failed = false;

for (const name of await readdir(packagesDir)) {
  const dir = join(packagesDir, name);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (!pkg.vgpuBundleBudgetGzipBytes) continue;
  execFileSync("pnpm", ["--dir", dir, "pack", "--pack-destination", dir], { stdio: "ignore" });
  const tarball = join(dir, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
  const gzipBytes = await gzipSize(tarball);
  rmSync(tarball, { force: true });
  console.log(`${pkg.name}: ${gzipBytes} B gzip / ${pkg.vgpuBundleBudgetGzipBytes} B budget`);
  if (gzipBytes > pkg.vgpuBundleBudgetGzipBytes) failed = true;
}

if (failed) process.exit(1);

function gzipSize(path) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    createReadStream(path)
      .pipe(createGzip())
      .on("data", (chunk) => { bytes += chunk.length; })
      .on("end", () => resolve(bytes))
      .on("error", reject);
  });
}
