import { resolveShader } from "../runtime/resolveShader.ts";
import { hasTopLevelImport } from "../runtime/scanner.ts";

export interface ViteLoadResult { readonly code: string; readonly map: null }

export async function transformWgsl(source: string, id: string): Promise<ViteLoadResult> {
  if (!hasTopLevelImport(source)) return { code: `export default ${JSON.stringify(source)};`, map: null };
  const resolved = await resolveShader({ entry: id, validate: false });
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
