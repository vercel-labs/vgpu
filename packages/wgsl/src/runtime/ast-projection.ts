import { hash8, type MangleModule } from "./mangler.ts";
import type { SourceMap, WGSLModule } from "./resolve-shader.ts";
import { parseDeclarations } from "./reflect-declarations.ts";

export function sourceMap(modules: readonly MangleModule[]): SourceMap {
  return { version: 3, sources: modules.map((module) => module.path), mappings: "" };
}

export function toAstModule(module: MangleModule): WGSLModule {
  return {
    path: module.path,
    bytes: new TextEncoder().encode(module.source).byteLength,
    hash8: hash8(module.path),
    entryPointDeclarations: parseDeclarations(module).entries.map((entry) => ({
      name: entry.name,
      stage: entry.stage,
      span: {
        start: { line: entry.declarationStartToken.line, column: entry.declarationStartToken.column },
        end: { line: entry.declarationEndToken.line, column: entry.declarationEndToken.column + entry.declarationEndToken.text.length },
      },
    })),
    exports: module.parsed.exports.map((exp) => ({ name: exp.name, localName: exp.localName, sourcePath: module.path })),
    imports: module.parsed.imports.map((imp) => ({ from: imp.from, bindings: imp.bindings.map((b) => ({ local: b.local, imported: b.imported })) })),
  };
}
