import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

/** Returns a stable content identity for the built @vgpu/wgsl JavaScript tree. */
export function wgslLoaderFingerprint(loaderPath) {
  const loader = realpathSync(loaderPath);
  const dist = wgslDistDirectory(loader);
  const files = javascriptFiles(dist).sort((a, b) => {
    const aPath = fingerprintPath(dist, a);
    const bPath = fingerprintPath(dist, b);
    return aPath < bPath ? -1 : aPath > bPath ? 1 : 0;
  });
  if (!files.includes(loader)) throw new Error(`WGSL loader is outside its built JavaScript tree: ${loader}`);

  const hash = createHash("sha256");
  hash.update("vgpu-wgsl-dist-js-v1\0");
  for (const file of files) {
    const path = fingerprintPath(dist, file);
    const source = readFileSync(file);
    hash.update(`${Buffer.byteLength(path)}:${path}:${source.byteLength}:`);
    hash.update(source);
  }
  return `sha256:${hash.digest("hex")}`;
}

function wgslDistDirectory(loader) {
  let directory = dirname(loader);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@vgpu/wgsl") {
        const dist = realpathSync(join(directory, "dist"));
        if (loader !== dist && !loader.startsWith(`${dist}${sep}`)) {
          throw new Error(`Resolved WGSL loader is outside @vgpu/wgsl/dist: ${loader}`);
        }
        return dist;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate the @vgpu/wgsl package for ${loader}`);
}

function javascriptFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) javascriptFiles(path, result);
    else if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(extname(entry.name))) result.push(realpathSync(path));
  }
  return result;
}

function fingerprintPath(root, file) {
  return relative(root, file).replaceAll("\\", "/");
}
