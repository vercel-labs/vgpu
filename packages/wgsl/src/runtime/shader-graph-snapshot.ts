import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalEntry, resolveImport } from "./package-resolution.ts";
import { loadModuleGraph, type ModuleGraph } from "./module-graph.ts";
import type { DiagnosticList } from "./diagnostic-types.ts";
import { checkedSnapshot } from "./shader-graph-validation.ts";
import { graphLimits, readShaderSource, readShaderPackageManifest } from "./shader-graph-files.ts";

export interface ShaderGraphSnapshot {
  readonly schemaVersion: 1;
  readonly entries: Readonly<Record<string, string>>;
  readonly modules: Readonly<Record<string, { readonly source: string; readonly imports: Readonly<Record<string, string>> }>>;
  readonly inputs: readonly { readonly module: string; readonly physicalPath: string; readonly sha256: string }[];
}

export interface CaptureShaderGraphOptions {
  readonly entries: Readonly<Record<string, string>>;
  readonly rootDir: string;
  readonly signal?: AbortSignal;
  readonly onDependency?: (path: string) => void;
}

export async function captureShaderGraph(options: CaptureShaderGraphOptions): Promise<ShaderGraphSnapshot> {
  const { signal, rootDir, onDependency } = options;
  signal?.throwIfAborted();
  if (typeof rootDir !== "string" || !isAbsolute(rootDir) || rootDir.includes("\0")) throw new TypeError("rootDir must be an absolute directory path");
  const configuredEntries = Object.entries(options.entries);
  if (configuredEntries.length === 0) throw new TypeError("Capture requires at least one named entry");
  for (const [key, path] of configuredEntries) {
    if (!key || typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new TypeError("Capture requires named absolute entry paths");
  }
  if (!statSync(rootDir).isDirectory()) throw new TypeError("rootDir must identify a directory");
  const diagnostics: DiagnosticList[number][] = [];
  let totalBytes = 0;
  const entries = new Map(configuredEntries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, path]) => [key, canonicalEntry(path, { entry: path, rootDir })]));
  const graph = await loadModuleGraph([...entries.values()], {
    maxModules: graphLimits.modules,
    maxDepth: graphLimits.depth,
    read: async (path) => {
      const source = await readShaderSource(path, signal);
      totalBytes += Buffer.byteLength(source);
      if (totalBytes > graphLimits.totalBytes) throw new RangeError("Shader graph exceeds 32 MiB");
      return source;
    },
    resolve: (specifier, from) => {
      signal?.throwIfAborted();
      return resolveImport(specifier, from, { entry: from, rootDir, readPackageManifest: (path) => readShaderPackageManifest(path, signal) }, diagnostics);
    },
    onDependency,
  });
  const ids = new Map([...graph.modules.keys()].map((path, index) => [path, `modules/${String(index).padStart(4, "0")}.wgsl`]));
  const modules: Record<string, { source: string; imports: Readonly<Record<string, string>> }> = Object.create(null);
  const inputs = [];
  for (const [path, module] of graph.modules) {
    const id = ids.get(path)!;
    const edges = [...graph.edges.get(path)!].map(([specifier, target]) => [specifier, ids.get(target)!] as const);
    modules[id] = Object.freeze({ source: module.source, imports: Object.freeze(Object.fromEntries(edges)) });
    inputs.push(Object.freeze({ module: id, physicalPath: path, sha256: createHash("sha256").update(module.source).digest("hex") }));
  }
  const snapshot: ShaderGraphSnapshot = Object.freeze({
    schemaVersion: 1,
    entries: Object.freeze(Object.fromEntries([...entries].map(([key, path]) => [key, ids.get(path)!]))),
    modules: Object.freeze(modules), inputs: Object.freeze(inputs),
  });
  return snapshot;

}

export async function capturedShaderGraph(snapshot: ShaderGraphSnapshot): Promise<{ graph: ModuleGraph; diagnostics: DiagnosticList }> {
  const checked = checkedSnapshot(snapshot);
  const entries = checked.entries;
  const modules = new Map(Object.entries(checked.modules).map(([id, module]) => [id, { source: module.source, imports: new Map(Object.entries(module.imports)) }]));
  const graph = await loadModuleGraph(Object.values(entries), {
    maxModules: graphLimits.modules,
    maxDepth: graphLimits.depth,
    read: async (path) => {
      const module = modules.get(path);
      if (!module) throw new TypeError(`Unknown snapshot module ${path}`);
      return module.source;
    },
    resolve: (specifier, from) => {
      const target = modules.get(from)?.imports.get(specifier);
      if (target === undefined || !modules.has(target)) throw new TypeError(`Unknown snapshot import ${specifier} from ${from}`);
      return target;
    },
  });
  if (graph.modules.size !== modules.size) throw new TypeError("Snapshot contains unreachable modules");
  for (const [id, module] of modules) {
    if (module.imports.size !== graph.edges.get(id)!.size) throw new TypeError(`Snapshot contains additional import edges for ${id}`);
  }
  return { graph, diagnostics: [] };
}
