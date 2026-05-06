import { hash8, type MangleModule } from "./mangler.ts";
import type { SourceMap, WGSLModule } from "./resolveShader.ts";

export function sourceMap(modules: readonly MangleModule[]): SourceMap {
  return { version: 3, sources: modules.map((module) => module.path), mappings: "" };
}

export function toAstModule(module: MangleModule): WGSLModule {
  return {
    path: module.path,
    bytes: new TextEncoder().encode(module.source).byteLength,
    hash8: hash8(module.path),
    exports: module.parsed.exports.map((exp) => ({ name: exp.name, localName: exp.localName, sourcePath: module.path })),
    imports: module.parsed.imports.map((imp) => ({ from: imp.from, bindings: imp.bindings.map((b) => ({ local: b.local, imported: b.imported })) })),
  };
}
