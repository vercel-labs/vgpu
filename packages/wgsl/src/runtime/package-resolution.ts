import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { wgslError, wgslWarning } from "./errors.ts";
import type { Diagnostic } from "./diagnostic-types.ts";

export interface PackageResolveOptions { readonly entry: string; readonly rootDir?: string; readonly packageMap?: Record<string, string>; readonly modules?: Record<string, string> }

const entrySourceKey = Symbol("@vgpu/wgsl entry source");
interface EntrySourceOverride { readonly path: string; readonly source: string }
type InternalPackageResolveOptions = PackageResolveOptions & {
  readonly [entrySourceKey]?: EntrySourceOverride;
};

/** Internal loader bridge: overlay only the bundler-provided entry while imports keep normal resolution. */
export function withEntrySource<Options extends PackageResolveOptions>(
  options: Options,
  source: string,
): Options {
  return {
    ...options,
    [entrySourceKey]: { path: resolve(options.entry), source },
  };
}

/** Fix-it for a bare package specifier that is not installed. WGSL packages are npm packages: `@vgpu/wgsl-std` ships with `vgpu`, anything else has to be installed. */
export const PKG_NOTFOUND_FIXIT = "Install the package (npm install <pkg>) or check the specifier";
/** Fix-it for the in-memory (`modules`) resolver, where node_modules is never consulted. */
export const PKG_NOTFOUND_VIRTUAL_FIXIT = "Map it with packageMap or add the module to modules";

/** Package name of a bare specifier: `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
export function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0]!;
}

function packageNotFound(pkg: string, fixit: string): ReturnType<typeof wgslError> {
  return wgslError("VGPU-WGSL-PKG-NOTFOUND", `Package ${pkg} was not found. ${fixit.replace("<pkg>", pkg)}`);
}

export function resolveImport(spec: string, from: string, opts: PackageResolveOptions, diagnostics: Diagnostic[]): string {
  if (spec.startsWith("/")) throw wgslError("VGPU-WGSL-RES-ABS", "Absolute WGSL imports are not portable");
  if (spec.startsWith("@/") && opts.rootDir) return opts.modules ? defaultVirtual(join(opts.rootDir, spec.slice(2)), opts.modules) : defaultFile(join(opts.rootDir, spec.slice(2)));
  for (const [prefix, target] of Object.entries(opts.packageMap ?? {})) if (spec.startsWith(prefix)) return opts.modules ? defaultVirtual(join(target, spec.slice(prefix.length)), opts.modules) : defaultFile(join(target, spec.slice(prefix.length)));
  if (opts.modules && (spec.startsWith("./") || spec.startsWith("../"))) return defaultVirtual(join(dirname(from), spec), opts.modules);
  if (opts.modules) throw packageNotFound(packageNameOf(spec), PKG_NOTFOUND_VIRTUAL_FIXIT);
  if (spec.startsWith("./") || spec.startsWith("../")) return defaultFile(resolve(dirname(from), spec));
  return packageImport(spec, from, diagnostics);
}

export async function readModule(path: string, opts: PackageResolveOptions): Promise<string> {
  const entrySource = (opts as InternalPackageResolveOptions)[entrySourceKey];
  if (entrySource?.path === path) return entrySource.source;
  const text = opts.modules?.[path];
  if (text !== undefined) return text;
  if (existsSync(path)) return await readFile(path, "utf8");
  throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${path} was not found`);
}

export function canonicalEntry(entry: string, opts: PackageResolveOptions): string {
  const entrySource = (opts as InternalPackageResolveOptions)[entrySourceKey];
  if (entrySource !== undefined) return entrySource.path;
  return opts.modules ? defaultVirtual(entry, opts.modules) : defaultFile(resolve(entry));
}

function packageImport(spec: string, from: string, diagnostics: Diagnostic[]): string {
  const pkg = packageNameOf(spec);
  const sub = `.${spec.slice(pkg.length) || ""}`;
  // Project-local first: the importing project's own node_modules always wins, so a project can
  // override or pin a WGSL package. The workspace root is found once, from the path as written, and
  // both passes are bounded by it — the second pass may look at another *spelling* of this project,
  // never at another project.
  const start = dirname(from);
  const boundary = workspaceBoundary(start);
  const local = walkForPackage(start, boundary, pkg, sub, diagnostics);
  if (local) return local;
  // Same walk from the importer's real path, which is what rescues a WGSL package that imports
  // another WGSL package under pnpm (see walkForPackage).
  const real = realPathOf(start);
  const realBoundary = realPathOf(boundary);
  if (real !== start && isInside(real, realBoundary)) {
    const stored = walkForPackage(real, realBoundary, pkg, sub, diagnostics);
    if (stored) return stored;
  }
  // Yarn PnP installs packages inside zip archives with no node_modules directories at all, so the
  // walk above can never see them. Ask Node — the PnP runtime hooks its resolver *and* patches `fs`,
  // so the zip-internal path it returns is readable by existsSync/readFile like any other file.
  // Resolving from the importer (not from this module) keeps the resolution in the user's own
  // dependency graph: it can reach what the shader's package declares and nothing else.
  if (process.versions.pnp) {
    const pnp = resolveFromImporter(spec, from);
    if (pnp) return pnp;
  }
  if (pkg.startsWith("@vgpu/")) {
    const transitive = resolveAlongsideResolver(spec);
    if (transitive) return transitive;
  }
  throw packageNotFound(pkg, PKG_NOTFOUND_FIXIT);
}

/**
 * One node_modules walk from `start` up to and including `stopAt`, which is always the importing
 * project's workspace root: a shader never picks up packages from outside its own project.
 *
 * `packageImport` runs this twice, and the second pass — from the importer's real path — is what
 * makes a *third-party WGSL package that imports another WGSL package* work under pnpm:
 * `node_modules/@acme/fbm` is a symlink into `node_modules/.pnpm/@acme+fbm@<v>/`, and `@acme/fbm`'s
 * own dependencies are installed next to that store entry, not next to the symlink, so the symlinked
 * chain never reaches them. Resolving the link first puts the walk inside the store, where they are
 * visible — this is also how Node itself resolves (it realpaths by default).
 *
 * Both passes are bounded by the *same* project, because a symlink can also point out of it:
 * `npm link` aims a dependency at an unrelated checkout, whose own parent directories may hold
 * packages this project never installed (another project's node_modules, or `$HOME`'s). Re-deriving
 * the boundary from the real path would look for workspace-root markers along that foreign tree,
 * find none, and walk to the filesystem root. So `packageImport` finds the boundary once from the
 * path as written and skips the second pass entirely when the real path escapes it, leaving a linked
 * package's own imports to fail with PKG-NOTFOUND rather than resolve to something arbitrary.
 */
function walkForPackage(start: string, stopAt: string, pkg: string, sub: string, diagnostics: Diagnostic[]): string | undefined {
  for (let dir = start;;) {
    const pkgJson = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(pkgJson)) return packageExport(pkgJson, sub, diagnostics);
    if (dir === stopAt) return undefined;
    const next = dirname(dir); if (next === dir) return undefined; dir = next;
  }
}

/** Nearest enclosing workspace root, i.e. how far up a node_modules walk from `start` may go. Terminates at the filesystem root, which `isWorkspaceRoot` treats as a boundary. */
function workspaceBoundary(start: string): string {
  let dir = start;
  while (!isWorkspaceRoot(dir)) dir = dirname(dir);
  return dir;
}

function realPathOf(dir: string): string {
  try { return realpathSync(dir); } catch { return dir; }
}

/** Both paths are canonical (`realpathSync`), so containment is a prefix test on path segments. */
function isInside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Node resolution from the importing shader's own location. Used under Yarn PnP, where there is no node_modules tree to walk. */
function resolveFromImporter(spec: string, from: string): string | undefined {
  try { return defaultFile(createRequire(from).resolve(spec)); } catch { return undefined; }
}

/**
 * Last resort: resolve the specifier from *this module's* install location instead of the shader's.
 *
 * Walking up from the shader only finds packages hoisted into the project's node_modules chain,
 * which is why `@vgpu/wgsl-std` reaching a project transitively through `vgpu` worked under npm
 * (accidental hoisting) but failed under pnpm's isolated store and Yarn PnP. `@vgpu/wgsl` depends on
 * `@vgpu/wgsl-std`, so the package manager guarantees it next to *us* in every layout. Node's own
 * resolver is used rather than another node_modules walk because it honors `exports` maps and is the
 * only thing that works under Yarn PnP.
 *
 * This runs after the loop above, so it never shadows a project-local copy. Scoped to `@vgpu/*`
 * specifiers only: it exists solely to rescue vgpu's own transitives in isolated pnpm/PnP layouts.
 * Any other bare specifier that happens to be reachable from `@vgpu/wgsl`'s own install location
 * (e.g. a devDependency like `webpack`) must NOT resolve here — it should fail with
 * VGPU-WGSL-PKG-NOTFOUND instead of silently picking up an unrelated JS file that then fails much
 * later with a confusing parse error.
 */
function resolveAlongsideResolver(spec: string): string | undefined {
  try {
    return defaultFile(createRequire(import.meta.url).resolve(spec));
  } catch {
    return undefined;
  }
}

function packageExport(pkgJson: string, sub: string, diagnostics: Diagnostic[]): string {
  const root = dirname(pkgJson);
  const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string; exports?: Record<string, string | Record<string, string>> };
  const value = parsed.exports?.[sub];
  if (typeof value === "string") return defaultFile(join(root, value));
  if (value && typeof value.default === "string") {
    warnOnce(diagnostics, "VGPU-WGSL-PKG-CONDITIONAL", `Package export ${sub} uses conditional exports; selecting default`);
    return defaultFile(join(root, value.default));
  }
  for (const [key, target] of Object.entries(parsed.exports ?? {})) if (key.includes("*") && typeof target === "string") {
    const [before, after] = key.split("*") as [string, string];
    if (sub.startsWith(before) && sub.endsWith(after)) return defaultFile(join(root, target.replace("*", sub.slice(before.length, sub.length - after.length))));
  }
  throw wgslError("VGPU-WGSL-PKG-NOTFOUND", `Package export ${sub} was not found in ${parsed.name ?? root}. Check the package's exports map or fix the import subpath`);
}

function warnOnce(diagnostics: Diagnostic[], code: string, message: string): void { if (!diagnostics.some((item) => item.code === code && item.message === message)) diagnostics.push(wgslWarning(code, message)); }
function defaultVirtual(path: string, modules: Record<string, string>): string { const clean = normalize(path).replace(/\\/g, "/"); if (modules[clean] !== undefined) return clean; if (modules[`${clean}.wgsl`] !== undefined) return `${clean}.wgsl`; if (modules[`${clean}/index.wgsl`] !== undefined) return `${clean}/index.wgsl`; throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${clean} was not found`); }
function defaultFile(path: string): string { if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.wgsl"); for (const choice of extname(path) ? [path] : [`${path}.wgsl`, join(path, "index.wgsl")]) if (existsSync(choice)) return choice; throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${path} was not found`); }
function isWorkspaceRoot(dir: string): boolean { return existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, ".git")) || dirname(dir) === dir; }
