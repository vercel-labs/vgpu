import type { MangleModule } from "./mangler.ts";
import { analyzeWgslTokens, type ScopeAnalysis } from "./scope-walker.ts";
import type { BindingInfo, BindingRef, ParsedDecls, ParsedEntryPoint, SamplingPair } from "./reflect-types.ts";
import { numericAttr } from "./reflect-utils.ts";

const filteringCalls = new Set(["textureSample", "textureSampleBias", "textureSampleLevel", "textureSampleGrad", "textureGather", "textureSampleBaseClampToEdge"]);
const comparisonCalls = new Set(["textureSampleCompare", "textureSampleCompareLevel", "textureGatherCompare"]);
type Origin = BindingRef;

/** Finds the sampler/texture capability relations which affect auto-layout-like inference. */
export function entrySamplingPairs(modules: readonly MangleModule[], raw: readonly ParsedDecls[], bindings: readonly BindingInfo[]): ReadonlyMap<ParsedEntryPoint, readonly SamplingPair[]> {
  const result = new Map<ParsedEntryPoint, readonly SamplingPair[]>();
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex]!;
    const decls = raw[moduleIndex]!;
    const analysis = analyzeWgslTokens(module.tokens);
    const bindingDeclarations = new Map<number, BindingRef>();
    for (const variable of decls.vars) {
      const group = numericAttr(variable.attrs, "group"), binding = numericAttr(variable.attrs, "binding");
      const declaration = analysis.declarations.find((item) => item.kind === "global" && item.name === variable.name);
      if (group !== undefined && binding !== undefined && declaration) bindingDeclarations.set(declaration.id, { group, binding });
    }
    const functionDeclarations = new Map<number, number>();
    for (const declaration of analysis.declarations) {
      if (declaration.kind !== "function") continue;
      const fn = analysis.functions.find((item) => item.nameTokenIndex === declaration.tokenIndex);
      if (fn) functionDeclarations.set(declaration.id, fn.id);
    }
    for (const entry of decls.entries) {
      const root = analysis.functions.find((fn) => fn.name === entry.name);
      const pairs: SamplingPair[] = [];
      let fallback = analysis.fallback.wholeModule || module.parsed.imports.length > 0 || !root;
      if (!fallback && root) fallback = !walk(root.id, new Map(), new Set(), analysis, bindingDeclarations, functionDeclarations, pairs);
      result.set(entry, fallback ? conservativePairs(bindings) : dedupe(pairs));
    }
  }
  return result;
}

function walk(functionId: number, env: ReadonlyMap<number, Origin>, visited: Set<string>, analysis: ScopeAnalysis, globals: ReadonlyMap<number, Origin>, functions: ReadonlyMap<number, number>, output: SamplingPair[]): boolean {
  const fn = analysis.functions[functionId];
  if (!fn || fn.skipped) return false;
  const key = `${functionId}|${[...env].map(([id, ref]) => `${id}:${ref.group}:${ref.binding}`).join(",")}`;
  if (visited.has(key)) return true;
  visited.add(key);
  const refs = analysis.references.filter((ref) => ref.functionId === functionId);
  const refAt = new Map(refs.map((ref) => [ref.tokenIndex, ref]));
  for (let i = fn.bodyStartToken + 1; i < fn.bodyEndToken; i++) {
    const name = analysis.tokens[i]?.text;
    const mode = filteringCalls.has(name ?? "") ? "filtering" : comparisonCalls.has(name ?? "") ? "comparison" : undefined;
    const reference = refAt.get(i);
    const callee = reference && functions.get(reference.declarationId);
    if (!mode && callee === undefined) continue;
    const open = nextSignificant(analysis, i);
    if (open === undefined || analysis.tokens[open]?.text !== "(") continue;
    const ranges = argumentRanges(analysis, open);
    if (!ranges) return false;
    const origins = ranges.map(([start, end]) => resolveOrigin(start, end, analysis, globals, env));
    if (mode) {
      const resolved = origins.filter((item): item is Origin => !!item);
      if (resolved.length < 2) return false;
      output.push({ texture: resolved[0]!, sampler: resolved[1]!, mode });
    } else {
      const params = analysis.declarations.filter((decl) => decl.kind === "param" && decl.functionId === callee).sort((a, b) => a.tokenIndex - b.tokenIndex);
      const nextEnv = new Map<number, Origin>();
      for (let p = 0; p < params.length; p++) if (origins[p]) nextEnv.set(params[p]!.id, origins[p]!);
      if (!walk(callee!, nextEnv, visited, analysis, globals, functions, output)) return false;
    }
  }
  return true;
}

function resolveOrigin(start: number, end: number, analysis: ScopeAnalysis, globals: ReadonlyMap<number, Origin>, env: ReadonlyMap<number, Origin>): Origin | undefined {
  for (const ref of analysis.references) {
    if (ref.tokenIndex < start || ref.tokenIndex > end) continue;
    const origin = globals.get(ref.declarationId) ?? env.get(ref.declarationId);
    if (origin) return origin;
  }
  return undefined;
}

function argumentRanges(analysis: ScopeAnalysis, open: number): readonly [number, number][] | undefined {
  const ranges: [number, number][] = [];
  let paren = 1, bracket = 0, brace = 0, angle = 0, start = open + 1;
  for (let i = open + 1; i < analysis.tokens.length; i++) {
    const text = analysis.tokens[i]!.text;
    if (text === "(") paren++;
    else if (text === ")") { paren--; if (paren === 0) { ranges.push([start, i - 1]); return ranges; } }
    else if (text === "[") bracket++; else if (text === "]") bracket--;
    else if (text === "{") brace++; else if (text === "}") brace--;
    else if (text === "<") angle++; else if (text === ">") angle--;
    else if (text === "," && paren === 1 && bracket === 0 && brace === 0 && angle === 0) { ranges.push([start, i - 1]); start = i + 1; }
  }
  return undefined;
}

function nextSignificant(analysis: ScopeAnalysis, index: number): number | undefined {
  for (let i = index + 1; i < analysis.tokens.length; i++) if (analysis.tokens[i]!.kind !== "lineComment" && analysis.tokens[i]!.kind !== "blockComment") return i;
  return undefined;
}

function conservativePairs(bindings: readonly BindingInfo[]): readonly SamplingPair[] {
  const textures = bindings.filter((item) => item.bindingLayout?.kind === "texture" && item.bindingLayout.texture.sampleType === "unfilterable-float" && !item.bindingLayout.texture.multisampled);
  const samplers = bindings.filter((item) => item.bindingLayout?.kind === "sampler" && item.bindingLayout.sampler.type === "filtering");
  return textures.flatMap((texture) => samplers.map((sampler) => ({ texture: ref(texture), sampler: ref(sampler), mode: "filtering" as const })));
}
function ref(binding: BindingInfo): BindingRef { return { group: binding.group, binding: binding.binding }; }
function dedupe(pairs: readonly SamplingPair[]): readonly SamplingPair[] {
  const seen = new Set<string>();
  return pairs.filter((pair) => { const key = `${pair.texture.group}:${pair.texture.binding}:${pair.sampler.group}:${pair.sampler.binding}:${pair.mode}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
