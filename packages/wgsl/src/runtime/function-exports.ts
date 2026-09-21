import type { ShaderFunctionExport } from "../types.ts";
import { isEntryPoint, mangle, type MangleModule } from "./mangler.ts";
import { analyzeWgslScopes, analyzeWgslTokens } from "./scope-walker.ts";

export interface FunctionExportCandidate {
  readonly name: string;
  readonly emittedName: string;
  readonly parameterNames: readonly string[];
}

export function collectFunctionExports(modules: readonly MangleModule[]): FunctionExportCandidate[] {
  const result: FunctionExportCandidate[] = [];

  for (const module of modules) {
    const analysis = analyzeWgslTokens(module.tokens);
    for (const exported of module.parsed.exports) {
      if (exported.kind !== "fn") continue;
      const fn = analysis.functions.find((item) => item.name === exported.localName);
      if (!fn) continue;

      const emittedName = isEntryPoint(module, exported.localName)
        ? exported.localName
        : mangle(module.path, exported.localName);

      const parameterNames = analysis.declarations
        .filter((declaration) => declaration.kind === "param" && declaration.functionId === fn.id)
        .sort((left, right) => left.tokenIndex - right.tokenIndex)
        .map((declaration) => declaration.name);
      result.push({ name: exported.name, emittedName, parameterNames });
    }
  }

  return result;
}

export function finalizeFunctionExports(
  candidates: readonly FunctionExportCandidate[],
  emittedWgsl: string,
  replacements: ReadonlyMap<number, string>,
): ShaderFunctionExport[] {
  const declarations = new Map(
    analyzeWgslScopes(emittedWgsl).functions.map((fn) => [fn.name, fn.nameTokenIndex] as const),
  );
  const result: ShaderFunctionExport[] = [];
  for (const item of candidates) {
    const tokenIndex = declarations.get(item.emittedName);
    if (tokenIndex === undefined) continue;
    result.push({
      name: item.name,
      resolvedName: replacements.get(tokenIndex) ?? item.emittedName,
      parameterNames: item.parameterNames,
    });
  }
  return result;
}
