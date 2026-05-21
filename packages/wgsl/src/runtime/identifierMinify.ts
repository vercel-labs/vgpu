import { printWgslTokens } from "./tokenPrinter.ts";
import { RenameAllocator } from "./renameAllocator.ts";
import { analyzeWgslTokens, type ScopeAnalysis, type ScopeDeclaration, type FunctionScopeInfo } from "./scopeWalker.ts";
import { scan, type Token } from "./scanner.ts";

export interface IdentifierMinifyResult {
  readonly wgsl: string;
  readonly replacements: ReadonlyMap<number, string>;
  readonly skippedHelperFunctions: readonly string[];
  readonly fallbackReasons: readonly string[];
}

const localKinds = new Set(["param", "let", "var", "const"] as const);

export function minifyWgslIdentifiers(source: string): string {
  return applyIdentifierMinifyWgsl(source).wgsl;
}

export interface ApplyIdentifierMinifyOptions {
  readonly whitespace?: boolean;
}

export function applyIdentifierMinifyWgsl(source: string, options: ApplyIdentifierMinifyOptions = {}): IdentifierMinifyResult {
  const tokens = scan(source);
  const analysis = analyzeWgslTokens(tokens);
  const replacements = buildIdentifierReplacements(analysis);
  return {
    wgsl: options.whitespace === false ? applyReplacementsPreservingTrivia(source, tokens, replacements) : printWgslTokens(tokens, { replacements }),
    replacements,
    skippedHelperFunctions: skippedHelpers(analysis, replacements),
    fallbackReasons: collectFallbackReasons(analysis),
  };
}

function applyReplacementsPreservingTrivia(source: string, tokens: readonly Token[], replacements: ReadonlyMap<number, string>): string {
  if (replacements.size === 0) return source;
  let out = "";
  let offset = 0;
  for (let i = 0; i < tokens.length; i++) {
    const replacement = replacements.get(i);
    if (replacement === undefined) continue;
    const token = tokens[i]!;
    out += source.slice(offset, token.start);
    out += replacement;
    offset = token.end;
  }
  out += source.slice(offset);
  return out;
}

export function buildIdentifierReplacements(analysis: ScopeAnalysis): Map<number, string> {
  const replacements = new Map<number, string>();
  if (analysis.fallback.wholeModule) return replacements;

  const fileScopeNames = collectFileScopeNames(analysis);
  renameHelperFunctions(analysis, fileScopeNames, replacements);
  renameFunctionLocals(analysis, fileScopeNames, replacements);
  return replacements;
}

function renameHelperFunctions(analysis: ScopeAnalysis, fileScopeNames: Set<string>, replacements: Map<number, string>): void {
  const helperDecls = analysis.declarations
    .filter((decl) => decl.kind === "function" && decl.safeToRename)
    .sort((a, b) => a.tokenIndex - b.tokenIndex);
  if (helperDecls.length === 0) return;

  const accounted = new Set<number>();
  for (const decl of helperDecls) {
    accounted.add(decl.tokenIndex);
    for (const ref of analysis.references) if (ref.declarationId === decl.id) accounted.add(ref.tokenIndex);
  }

  const reserved = allIdentifierTextsExcept(analysis.tokens, accounted);
  for (const name of fileScopeNames) reserved.add(name);
  const allocator = new RenameAllocator({ reserved });

  for (const decl of helperDecls) {
    if (!allOccurrencesAccountedFor(analysis, decl, accounted)) continue;
    const name = allocator.allocate();
    replacements.set(decl.tokenIndex, name);
    for (const ref of analysis.references) if (ref.declarationId === decl.id) replacements.set(ref.tokenIndex, name);
    fileScopeNames.add(name);
  }
}

function renameFunctionLocals(analysis: ScopeAnalysis, fileScopeNames: ReadonlySet<string>, replacements: Map<number, string>): void {
  const skippedFunctionIds = new Set(analysis.functions.filter((fn) => fn.skipped).map((fn) => fn.id));
  for (const fn of [...analysis.functions].sort((a, b) => a.id - b.id)) {
    if (skippedFunctionIds.has(fn.id)) continue;
    const declarations = analysis.declarations
      .filter((decl) => decl.functionId === fn.id && decl.safeToRename && localKinds.has(decl.kind as "param" | "let" | "var" | "const"))
      .sort((a, b) => a.tokenIndex - b.tokenIndex);
    if (declarations.length === 0) continue;

    const replaceable = new Set<number>();
    for (const decl of declarations) {
      replaceable.add(decl.tokenIndex);
      for (const ref of analysis.references) if (ref.declarationId === decl.id) replaceable.add(ref.tokenIndex);
    }

    const reserved = new Set(fileScopeNames);
    for (const name of inFunctionUnrenamedIdentifierTexts(analysis.tokens, fn, replaceable)) reserved.add(name);
    const allocator = new RenameAllocator({ reserved });

    for (const decl of declarations) {
      const name = allocator.allocate();
      replacements.set(decl.tokenIndex, name);
      for (const ref of analysis.references) if (ref.declarationId === decl.id) replacements.set(ref.tokenIndex, name);
    }
  }
}

function collectFileScopeNames(analysis: ScopeAnalysis): Set<string> {
  const names = new Set<string>();
  for (const decl of analysis.declarations) if (decl.functionId === undefined) names.add(decl.name);
  for (const item of analysis.preservedTokens) {
    if (item.reason === "global" || item.reason === "struct") {
      const token = analysis.tokens[item.tokenIndex];
      if (token?.kind === "ident") names.add(token.text);
    }
  }
  return names;
}

function allIdentifierTextsExcept(tokens: readonly Token[], except: ReadonlySet<number>): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "ident" && !except.has(i)) names.add(token.text);
  }
  return names;
}

function inFunctionUnrenamedIdentifierTexts(tokens: readonly Token[], fn: FunctionScopeInfo, replaceable: ReadonlySet<number>): Set<string> {
  const names = new Set<string>();
  for (let i = fn.nameTokenIndex; i <= fn.bodyEndToken; i++) {
    const token = tokens[i];
    if (token?.kind === "ident" && !replaceable.has(i)) names.add(token.text);
  }
  return names;
}

function allOccurrencesAccountedFor(analysis: ScopeAnalysis, decl: ScopeDeclaration, accounted: ReadonlySet<number>): boolean {
  for (let i = 0; i < analysis.tokens.length; i++) {
    const token = analysis.tokens[i]!;
    if (token.kind === "ident" && token.text === decl.name && !accounted.has(i)) return false;
  }
  return true;
}

function skippedHelpers(analysis: ScopeAnalysis, replacements: ReadonlyMap<number, string>): string[] {
  return analysis.declarations
    .filter((decl) => decl.kind === "function" && decl.safeToRename && !replacements.has(decl.tokenIndex))
    .map((decl) => decl.name);
}

function collectFallbackReasons(analysis: ScopeAnalysis): string[] {
  return [
    ...analysis.fallback.reasons,
    ...analysis.functions.flatMap((fn) => fn.fallbackReasons),
  ];
}
