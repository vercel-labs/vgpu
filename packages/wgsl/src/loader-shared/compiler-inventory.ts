import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { VGPUError, wgslErrorWithFix } from "../runtime/errors.ts";

const CACHE_IDENTITY_FIX = "Reinstall the matching @vgpu/wgsl release; for a workspace installation, build the package before running Next. Check the reported path.";
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export interface CompilerFiles {
  readonly files: readonly string[];
  readonly loader: string;
  readonly packageRoot: string;
  readonly sourceMode: boolean;
}

export interface CompilerInventory extends CompilerFiles {
  readonly fingerprint: string;
}

export function compilerFilesForModule(
  moduleUrl: string,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
): CompilerFiles {
  const modulePath = realpath(moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl, where);
  const packageRoot = findPackageRoot(modulePath, where);
  const manifestPath = join(packageRoot, "package.json");
  const manifest = readManifest(manifestPath, where);
  if (manifest.name !== "@vgpu/wgsl") {
    throw cacheIdentityError(where, `Expected ${manifestPath} to describe @vgpu/wgsl.`, undefined, manifestPath);
  }

  const moduleRelative = portableRelative(packageRoot, modulePath);
  const sourceMode = moduleRelative.startsWith("src/") && moduleRelative.endsWith(".ts");
  if (!sourceMode && !(moduleRelative.startsWith("dist/") && JAVASCRIPT_EXTENSIONS.has(extname(modulePath)))) {
    throw cacheIdentityError(where, `Compiler module is outside the @vgpu/wgsl source or published JavaScript tree: ${modulePath}`, undefined, modulePath);
  }

  const anchor = resolvePackageFile(packageRoot, manifest.exports?.["./_metadata.wgsl"], "./src/metadata.wgsl", where, "metadata anchor");
  const declaredLoader = sourceMode
    ? requiredFile(join(packageRoot, "src/loader-webpack/index.ts"), where)
    : publishedLoader(packageRoot, manifest, where);
  const loader = !sourceMode && where === "wgslTurbopackRule"
    ? resolvedPublicLoader(moduleUrl, packageRoot, declaredLoader, where)
    : declaredLoader;
  const implementationFiles = sourceMode
    ? sourceImplementationFiles(join(packageRoot, "src"), where)
    : publishedJavaScriptFiles(join(packageRoot, "dist"), where);
  const files = [manifestPath, anchor, ...implementationFiles]
    .map((file) => inventoryFile(file, packageRoot, where))
    .filter((file, index, all) => all.indexOf(file) === index)
    .sort((a, b) => compareCodePoints(portableRelative(packageRoot, a), portableRelative(packageRoot, b)));

  if (!containsRealTarget(files, modulePath)) {
    throw cacheIdentityError(where, `Compiler inventory does not contain its calling module: ${modulePath}`, undefined, modulePath);
  }
  if (!containsRealTarget(files, loader)) {
    throw cacheIdentityError(where, `Compiler inventory does not contain the public loader: ${loader}`, undefined, loader);
  }

  return { files, loader, packageRoot, sourceMode };
}

export function compilerInventoryForModule(
  moduleUrl: string,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
): CompilerInventory {
  const inventory = compilerFilesForModule(moduleUrl, where);
  const hash = createHash("sha256");
  hash.update("vgpu-wgsl-compiler-inventory-v1\0");
  for (const file of inventory.files) {
    const path = portableRelative(inventory.packageRoot, file);
    const bytes = readBytes(file, where);
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return {
    ...inventory,
    fingerprint: `sha256:${hash.digest("hex")}`,
  };
}

export function compilerDependencyError(
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
  path: string,
  cause: unknown,
): VGPUError {
  return cacheIdentityError(where, `Could not register WGSL compiler dependency: ${path}`, cause, path);
}

function findPackageRoot(modulePath: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): string {
  let directory = dirname(modulePath);
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) return realpath(directory, where);
    const parent = dirname(directory);
    if (parent === directory) {
      throw cacheIdentityError(where, `Could not locate the @vgpu/wgsl package for ${modulePath}.`, undefined, modulePath);
    }
    directory = parent;
  }
}

function publishedLoader(
  packageRoot: string,
  manifest: Record<string, any>,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
): string {
  const entry = manifest.exports?.["./loader-webpack"];
  if (!entry || typeof entry !== "object") {
    throw cacheIdentityError(where, "@vgpu/wgsl is missing the ./loader-webpack export.", undefined, join(packageRoot, "package.json"));
  }
  const targets = [entry.import, entry.require, entry.default];
  if (targets.some((target) => typeof target !== "string") || new Set(targets).size !== 1) {
    throw cacheIdentityError(where, "@vgpu/wgsl has inconsistent ./loader-webpack runtime targets.", undefined, join(packageRoot, "package.json"));
  }
  return resolvePackageFile(packageRoot, targets[0], undefined, where, "loader export");
}

function resolvedPublicLoader(
  moduleUrl: string,
  packageRoot: string,
  declaredLoader: string,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
): string {
  let resolved: string;
  try {
    resolved = realpathSync(createRequire(moduleUrl).resolve("@vgpu/wgsl/loader-webpack"));
  } catch (cause) {
    throw cacheIdentityError(where, "Could not resolve this @vgpu/wgsl installation's public loader.", cause, packageRoot);
  }
  if (resolved !== declaredLoader) {
    throw cacheIdentityError(where, `Resolved public loader does not match this @vgpu/wgsl manifest: ${resolved}`, undefined, resolved);
  }
  return resolved;
}

function resolvePackageFile(
  packageRoot: string,
  value: unknown,
  expected: string | undefined,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
  label: string,
): string {
  if (typeof value !== "string" || (expected !== undefined && value !== expected) || !value.startsWith("./")) {
    throw cacheIdentityError(where, `@vgpu/wgsl has an invalid ${label}.`, undefined, join(packageRoot, "package.json"));
  }
  const path = resolve(packageRoot, value);
  if (path !== packageRoot && !path.startsWith(`${packageRoot}${sep}`)) {
    throw cacheIdentityError(where, `@vgpu/wgsl ${label} escapes its package: ${value}`, undefined, path);
  }
  const target = requiredFile(path, where);
  if (target !== packageRoot && !target.startsWith(`${packageRoot}${sep}`)) {
    throw cacheIdentityError(where, `@vgpu/wgsl ${label} resolves outside its package: ${value}`, undefined, target);
  }
  return target;
}

function publishedJavaScriptFiles(directory: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): string[] {
  const files = collectFiles(directory, where, (path) => JAVASCRIPT_EXTENSIONS.has(extname(path)));
  if (files.length === 0) throw cacheIdentityError(where, `No published WGSL compiler JavaScript found in ${directory}.`, undefined, directory);
  return files;
}

function sourceImplementationFiles(directory: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): string[] {
  const files = collectFiles(directory, where, (path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
  if (files.length === 0) throw cacheIdentityError(where, `No WGSL compiler TypeScript found in ${directory}.`, undefined, directory);
  return files;
}

function collectFiles(
  directory: string,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
  include: (path: string) => boolean,
): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw cacheIdentityError(where, `Could not read WGSL compiler directory: ${directory}`, cause, directory);
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path, where, include));
    else if (entry.isSymbolicLink()) {
      if (linkedFile(path, where) && include(path)) files.push(path);
    } else if (entry.isFile() && include(path)) files.push(path);
  }
  return files;
}

function linkedFile(path: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): boolean {
  try {
    const target = statSync(path);
    if (target.isDirectory()) {
      throw cacheIdentityError(where, `Symbolic WGSL compiler directories are unsupported: ${path}`, undefined, path);
    }
    return target.isFile();
  } catch (cause) {
    if (cause instanceof VGPUError) throw cause;
    throw cacheIdentityError(where, `Could not inspect WGSL compiler asset: ${path}`, cause, path);
  }
}

function inventoryFile(
  path: string,
  packageRoot: string,
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
): string {
  const member = resolve(path);
  if (member !== packageRoot && !member.startsWith(`${packageRoot}${sep}`)) {
    throw cacheIdentityError(where, `WGSL compiler asset is outside its package: ${member}`, undefined, member);
  }
  const target = realpath(member, where);
  if (target !== packageRoot && !target.startsWith(`${packageRoot}${sep}`)) {
    throw cacheIdentityError(where, `WGSL compiler asset resolves outside its package: ${member}`, undefined, target);
  }
  return member;
}

function containsRealTarget(files: readonly string[], expected: string): boolean {
  return files.some((file) => realpathSync(file) === expected);
}

function readManifest(path: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("manifest is not an object");
    return value;
  } catch (cause) {
    throw cacheIdentityError(where, `Could not read @vgpu/wgsl manifest: ${path}`, cause, path);
  }
}

function readBytes(path: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw cacheIdentityError(where, `Could not read WGSL compiler asset: ${path}`, cause, path);
  }
}

function requiredFile(path: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): string {
  return realpath(path, where);
}

function realpath(path: string, where: "wgslTurbopackRule" | "wgslWebpackLoader"): string {
  try {
    return realpathSync(path);
  } catch (cause) {
    throw cacheIdentityError(where, `Could not resolve WGSL compiler asset: ${path}`, cause, path);
  }
}

function cacheIdentityError(
  where: "wgslTurbopackRule" | "wgslWebpackLoader",
  message: string,
  cause: unknown,
  path: string,
): VGPUError {
  return wgslErrorWithFix("VGPU-WGSL-CACHE-IDENTITY", message, {
    where,
    fix: CACHE_IDENTITY_FIX,
    cause,
    metadata: { path },
  });
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).replace(/\\/gu, "/");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
