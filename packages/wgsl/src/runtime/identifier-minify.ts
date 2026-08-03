import { wgslError } from "./errors.ts";
import { printWgslTokens } from "./token-printer.ts";
import { RenameAllocator } from "./rename-allocator.ts";
import { analyzeWgslTokens, type ScopeAnalysis, type ScopeDeclaration, type FunctionScopeInfo } from "./scope-walker.ts";
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
  assertNoDanglingLocalReferences(analysis, replacements);
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

    const ownTokens = new Map<number, Set<number>>();
    for (const decl of declarations) {
      const own = new Set<number>([decl.tokenIndex]);
      for (const ref of analysis.references) if (ref.declarationId === decl.id) own.add(ref.tokenIndex);
      ownTokens.set(decl.id, own);
    }

    const renameable = declarations.filter((decl) => allLocalOccurrencesAccountedFor(analysis.tokens, fn, decl.name, ownTokens.get(decl.id)!));

    const replaceable = new Set<number>();
    for (const decl of renameable) for (const token of ownTokens.get(decl.id)!) replaceable.add(token);

    const reserved = new Set(fileScopeNames);
    for (const name of inFunctionUnrenamedIdentifierTexts(analysis.tokens, fn, replaceable)) reserved.add(name);
    const allocator = new RenameAllocator({ reserved });

    for (const decl of renameable) {
      const name = allocator.allocate();
      for (const token of ownTokens.get(decl.id)!) replacements.set(token, name);
    }
  }
}

// Independent check that the scope analysis fully explains a local declaration before we shorten
// it: every identifier token inside the declaration's own function that is spelled like the
// declaration must be one of the occurrences the walker attributed to it. If anything else shares
// the spelling — a reference the walker lost (vgpu#251), a same-named declaration in a sibling or
// nested scope — the declaration is left alone, so a scope-analysis bug costs bytes instead of
// producing dangling or misattributed identifiers.
function allLocalOccurrencesAccountedFor(tokens: readonly Token[], fn: FunctionScopeInfo, name: string, own: ReadonlySet<number>): boolean {
  for (let i = fn.nameTokenIndex; i <= fn.bodyEndToken; i++) {
    const token = tokens[i];
    if (token?.kind === "ident" && token.text === name && !own.has(i)) return false;
  }
  return true;
}

/**
 * Post-renaming self-check: for every local this pass decided to rename, no token still spelled
 * with the local's original name may survive inside that local's function. That condition is
 * exactly the dangling-identifier failure of vgpu#251, and checking it needs no knowledge of WGSL
 * builtins or keywords — a re-scan of the printed WGSL would need such a list, because unresolved
 * builtin calls (`sin`, `select`, `vec4f`) are preserved with the same `"unknown"` reason as a
 * genuinely orphaned reference and are indistinguishable from one at the text level.
 *
 * This is an independently implemented second opinion on the invariant `renameFunctionLocals`
 * enforces up front, so it keeps working if that guard is ever changed or lost. It runs on every
 * identifier-safe minification and is not gated behind `ResolveOptions.validate`: it is linear in
 * token count, needs no GPU adapter, and emitting knowingly broken WGSL should not be opt-out.
 * It is inert when the walker fell back for the whole module, since nothing is renamed then.
 */
export function assertNoDanglingLocalReferences(analysis: ScopeAnalysis, replacements: ReadonlyMap<number, string>): void {
  for (const fn of analysis.functions) {
    const renamedLocalNames = new Set(
      analysis.declarations
        .filter((decl) => decl.functionId === fn.id && localKinds.has(decl.kind as "param" | "let" | "var" | "const") && replacements.has(decl.tokenIndex))
        .map((decl) => decl.name),
    );
    if (renamedLocalNames.size === 0) continue;
    for (let i = fn.nameTokenIndex; i <= fn.bodyEndToken; i++) {
      const token = analysis.tokens[i];
      if (token?.kind === "ident" && renamedLocalNames.has(token.text) && !replacements.has(i)) {
        throw wgslError(
          "VGPU-WGSL-MINIFY-DANGLING-IDENT",
          `Identifier-safe minification would leave a dangling reference to '${token.text}' in function '${fn.name}'; refusing to emit unsafe WGSL. This indicates a scope-analysis bug in @vgpu/wgsl — please report it at https://github.com/vercel-labs/vgpu/issues.`,
        );
      }
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
