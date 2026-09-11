import { remember } from "./lru.ts";
import { parseModule } from "./parser.ts";
import { scan } from "./scanner.ts";
import { wgslError } from "./errors.ts";
import type { MangleModule } from "./mangler.ts";

export interface ModuleGraph {
  readonly modules: ReadonlyMap<string, MangleModule>;
  readonly edges: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface GraphReader {
  read(path: string): Promise<string>;
  resolve(specifier: string, from: string): string;
  onDependency?: (path: string) => void;
  maxModules?: number;
  maxDepth?: number;
}

const scanCache = new Map<string, MangleModule>();

/** Capture each module and import choice once; emission never resolves an edge again. */
export async function loadModuleGraph(entries: readonly string[], reader: GraphReader): Promise<ModuleGraph> {
  const modules = new Map<string, MangleModule>();
  const edges = new Map<string, Map<string, string>>();
  const roots = new Set(entries);
  const depths = new Map<string, number>();
  for (const entry of entries) await visit(entry, []);
  return { modules, edges };

  async function visit(path: string, stack: string[]): Promise<void> {
    if (reader.maxDepth !== undefined && stack.length >= reader.maxDepth) throw new RangeError(`Shader graph exceeds ${reader.maxDepth} modules along an import chain`);
    if (stack.includes(path)) throw wgslError("VGPU-WGSL-IMP-SELF", `Import cycle: ${[...stack, path].join(" -> ")}`);
    if (modules.has(path)) {
      if (reader.maxDepth !== undefined && stack.length + depths.get(path)! > reader.maxDepth) throw new RangeError(`Shader graph exceeds ${reader.maxDepth} modules along an import chain`);
      return;
    }
    if (reader.maxModules !== undefined && modules.size >= reader.maxModules) throw new RangeError(`Shader graph exceeds ${reader.maxModules} modules`);
    const source = await reader.read(path);
    const cacheKey = JSON.stringify([path, source]);
    let module = scanCache.get(cacheKey);
    if (!module) {
      const tokens = scan(source, path);
      module = { path, source, tokens, parsed: parseModule(tokens) };
      remember(scanCache, cacheKey, module);
    }
    modules.set(path, module);
    const imports = new Map<string, string>();
    edges.set(path, imports);
    for (const imp of module.parsed.imports) {
      let dependency = imports.get(imp.from);
      if (dependency === undefined) {
        dependency = reader.resolve(imp.from, path);
        imports.set(imp.from, dependency);
      }
      if (!modules.has(dependency) && !roots.has(dependency)) reader.onDependency?.(dependency);
      await visit(dependency, [...stack, path]);
    }
    let depth = 1;
    for (const dependency of imports.values()) depth = Math.max(depth, 1 + depths.get(dependency)!);
    depths.set(path, depth);
  }
}

export function reachableModules(graph: ModuleGraph, entry: string): Map<string, MangleModule> {
  const result = new Map<string, MangleModule>();
  visit(entry);
  return result;
  function visit(path: string): void {
    if (result.has(path)) return;
    const module = graph.modules.get(path);
    if (!module) throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${path} is not in the captured graph`);
    result.set(path, module);
    for (const imp of module.parsed.imports) visit(resolvedEdge(graph, path, imp.from));
  }
}

export function resolvedEdge(graph: ModuleGraph, from: string, specifier: string): string {
  const target = graph.edges.get(from)?.get(specifier);
  if (target === undefined) throw wgslError("VGPU-WGSL-RES-NOTFOUND", `Import ${specifier} from ${from} is not in the captured graph`);
  return target;
}
