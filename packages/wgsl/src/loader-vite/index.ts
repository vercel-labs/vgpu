import { resolveShader } from "../runtime/resolveShader.ts";
import { hasTopLevelImport } from "../runtime/scanner.ts";

export interface ViteLoadResult { readonly code: string; readonly map: null }
export interface TransformWgslOptions { readonly source: string; readonly id: string; readonly onDependency?: (absPath: string) => void }

export function transformWgsl(source: string, id: string): Promise<ViteLoadResult>;
export function transformWgsl(opts: TransformWgslOptions): Promise<ViteLoadResult>;
export async function transformWgsl(sourceOrOpts: string | TransformWgslOptions, id?: string): Promise<ViteLoadResult> {
  const opts = typeof sourceOrOpts === "string" ? { source: sourceOrOpts, id: id ?? "<vite>" } : sourceOrOpts;
  if (!hasTopLevelImport(opts.source)) return { code: `export default ${JSON.stringify(opts.source)};`, map: null };
  const resolved = await resolveShader({ entry: opts.id, validate: false });
  for (const dep of resolved.deps) opts.onDependency?.(dep);
  return { code: `export default ${JSON.stringify(resolved.wgsl)};`, map: null };
}

export default function wgslVitePlugin(): { readonly name: string; readonly transform: (source: string, id: string) => Promise<ViteLoadResult | null> } {
  return {
    name: "@vgpu/wgsl",
    async transform(source, id) {
      if (!id.endsWith(".wgsl")) return null;
      return transformWgsl(source, id);
    },
  };
}
