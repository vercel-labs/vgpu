import type { Token } from "./scanner.ts";
import { scan } from "./scanner.ts";

const declarationKinds = new Set(["fn", "struct", "const", "alias", "var", "override"]);
const entryPointAttributes = new Set(["vertex", "fragment", "compute"]);

interface Declaration {
  readonly name: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly preserve: boolean;
  readonly references: readonly string[];
}

/**
 * Removes unreachable top-level WGSL declarations after import resolution.
 *
 * This pass is intentionally conservative: it only removes declarations with a
 * known WGSL top-level shape and only when the resolved module has one or more
 * shader entry points. Entry points, bindings/resources, and overrides are kept
 * as roots, then functions/types/constants reachable by identifier reference are
 * retained transitively.
 */
export function eliminateDeadDeclarations(source: string): string {
  const tokens = scan(source);
  const declarations = collectDeclarations(source, tokens);
  if (!declarations.some((decl) => decl.preserve && isEntryPoint(decl, tokens))) return source;

  const byName = new Map<string, Declaration>();
  for (const declaration of declarations) byName.set(declaration.name, declaration);

  const live = new Set<string>();
  const stack: Declaration[] = [];
  const markLive = (declaration: Declaration): void => {
    if (live.has(declaration.name)) return;
    live.add(declaration.name);
    stack.push(declaration);
  };
  for (const declaration of declarations) if (declaration.preserve) markLive(declaration);
  for (const reference of collectTopLevelDirectiveReferences(tokens)) {
    const declaration = byName.get(reference);
    if (declaration) markLive(declaration);
  }

  while (stack.length) {
    const declaration = stack.pop()!;
    for (const reference of declaration.references) {
      const target = byName.get(reference);
      if (!target || live.has(target.name)) continue;
      live.add(target.name);
      stack.push(target);
    }
  }

  let output = "";
  let cursor = 0;
  let removed = false;
  for (const declaration of declarations) {
    if (live.has(declaration.name)) continue;
    removed = true;
    output += source.slice(cursor, declaration.start);
    cursor = declaration.end;
  }
  return removed ? output + source.slice(cursor) : source;
}

function collectDeclarations(source: string, tokens: readonly Token[]): Declaration[] {
  const declarations: Declaration[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "{") { depth++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0 || !declarationKinds.has(token.text)) continue;

    const nameIndex = findDeclarationName(tokens, i);
    if (nameIndex === undefined) continue;
    const endIndex = findDeclarationEnd(tokens, i);
    if (endIndex === undefined) continue;
    const startIndex = findDeclarationStart(tokens, i);
    const declarationTokens = tokens.slice(startIndex, endIndex + 1);
    const declaration: Declaration = {
      name: tokens[nameIndex]!.text,
      kind: token.text,
      start: tokens[startIndex]!.start,
      end: tokens[endIndex]!.end,
      tokenStart: startIndex,
      tokenEnd: endIndex,
      preserve: mustPreserve(token.text, declarationTokens),
      references: collectReferences(tokens, startIndex, endIndex, nameIndex),
    };
    declarations.push(declaration);
    i = endIndex;
  }
  return declarations;
}

function findDeclarationName(tokens: readonly Token[], kindIndex: number): number | undefined {
  let i = kindIndex + 1;
  if (tokens[kindIndex]?.text === "var" && tokens[i]?.text === "<") {
    const close = findMatching(tokens, i, "<", ">");
    if (close === undefined) return undefined;
    i = close + 1;
  }
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "ident") return i;
    if (token.text === ";" || token.text === "{" || token.text === "}") return undefined;
  }
  return undefined;
}

function findDeclarationStart(tokens: readonly Token[], kindIndex: number): number {
  let start = kindIndex;
  while (start >= 2 && tokens[start - 2]?.text === "@" && isAttributeName(tokens[start - 1])) {
    start -= 2;
    if (tokens[start + 2]?.text === "(") {
      // The attribute has arguments between the name and the declaration kind.
      // Keep walking left; the current start already points at '@'.
    }
  }

  // The loop above covers argument-less attributes. For attributes with
  // arguments, walk left from the declaration kind across balanced parens and
  // adjacent @name(...) groups.
  let cursor = kindIndex - 1;
  while (cursor >= 0) {
    if (tokens[cursor]?.text === ")") {
      const open = findMatchingBackward(tokens, cursor, "(", ")");
      if (open === undefined || tokens[open - 2]?.text !== "@" || !isAttributeName(tokens[open - 1])) break;
      start = open - 2;
      cursor = start - 1;
      continue;
    }
    if (isAttributeName(tokens[cursor]) && tokens[cursor - 1]?.text === "@") {
      start = cursor - 1;
      cursor = start - 1;
      continue;
    }
    break;
  }
  return start;
}

function findDeclarationEnd(tokens: readonly Token[], kindIndex: number): number | undefined {
  const kind = tokens[kindIndex]!.text;
  if (kind === "fn" || kind === "struct") {
    const open = findNextText(tokens, kindIndex, "{");
    if (open === undefined) return undefined;
    const close = findMatching(tokens, open, "{", "}");
    if (close === undefined) return undefined;
    return tokens[close + 1]?.text === ";" ? close + 1 : close;
  }
  for (let i = kindIndex + 1; i < tokens.length; i++) {
    if (tokens[i]!.text === ";") return i;
    if (tokens[i]!.text === "{" || tokens[i]!.text === "}") return undefined;
  }
  return undefined;
}

function mustPreserve(kind: string, tokens: readonly Token[]): boolean {
  if (kind === "override") return true;
  if (kind === "var" && hasResourceBinding(tokens)) return true;
  return hasEntryPointAttribute(tokens);
}

function isEntryPoint(declaration: Declaration, tokens: readonly Token[]): boolean {
  return hasEntryPointAttribute(tokens.slice(declaration.tokenStart, declaration.tokenEnd + 1));
}

function hasEntryPointAttribute(tokens: readonly Token[]): boolean {
  return tokens.some((token, index) => tokens[index - 1]?.text === "@" && entryPointAttributes.has(token.text));
}

function hasResourceBinding(tokens: readonly Token[]): boolean {
  let hasGroup = false;
  let hasBinding = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i - 1]?.text !== "@") continue;
    hasGroup ||= tokens[i]!.text === "group";
    hasBinding ||= tokens[i]!.text === "binding";
  }
  return hasGroup && hasBinding;
}

function collectReferences(tokens: readonly Token[], start: number, end: number, nameIndex: number): string[] {
  const references: string[] = [];
  for (let i = start; i <= end; i++) {
    const token = tokens[i]!;
    if (i === nameIndex || token.kind !== "ident") continue;
    if (tokens[i - 1]?.text === "@" || tokens[i - 1]?.text === ".") continue;
    references.push(token.text);
  }
  return references;
}

function collectTopLevelDirectiveReferences(tokens: readonly Token[]): string[] {
  // `enable` and `diagnostic` directives do not name user declarations, but
  // `const_assert` contains a const-expression that can reference module-scope
  // constants/types. Keep those references as roots because the directive text
  // itself survives declaration slicing.
  const references: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "{") { depth++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0 || token.text !== "const_assert") continue;
    const end = findStatementEnd(tokens, i);
    if (end === undefined) continue;
    for (let j = i + 1; j < end; j++) {
      if (tokens[j]!.kind !== "ident") continue;
      if (tokens[j - 1]?.text === "@" || tokens[j - 1]?.text === ".") continue;
      references.push(tokens[j]!.text);
    }
    i = end;
  }
  return references;
}

function findStatementEnd(tokens: readonly Token[], start: number): number | undefined {
  for (let i = start + 1; i < tokens.length; i++) if (tokens[i]!.text === ";") return i;
  return undefined;
}

function findNextText(tokens: readonly Token[], start: number, text: string): number | undefined {
  for (let i = start + 1; i < tokens.length; i++) if (tokens[i]!.text === text) return i;
  return undefined;
}

function findMatching(tokens: readonly Token[], openIndex: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i]!.text === open) depth++;
    if (tokens[i]!.text === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function findMatchingBackward(tokens: readonly Token[], closeIndex: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (tokens[i]!.text === close) depth++;
    if (tokens[i]!.text === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function isAttributeName(token: Token | undefined): boolean {
  return token?.kind === "ident" || token?.kind === "keyword";
}
