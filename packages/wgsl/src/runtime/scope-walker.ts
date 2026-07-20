import { scan, type Token } from "./scanner.ts";

export type ScopeKind = "module" | "function" | "block" | "for-init";
export type DeclarationKind = "function" | "global" | "param" | "let" | "var" | "const";
export type PreserveReason = "attribute" | "member" | "type" | "directive" | "struct" | "global" | "unknown";

export interface ScopeFrameInfo {
  readonly id: number;
  readonly kind: ScopeKind;
  readonly parentId?: number;
  readonly functionId?: number;
  readonly startToken: number;
  readonly endToken?: number;
}

export interface ScopeDeclaration {
  readonly id: number;
  readonly name: string;
  readonly kind: DeclarationKind;
  readonly tokenIndex: number;
  readonly scopeId: number;
  readonly functionId?: number;
  readonly safeToRename: boolean;
}

export interface ScopeReference {
  readonly name: string;
  readonly tokenIndex: number;
  readonly declarationId: number;
  readonly scopeId: number;
  readonly functionId?: number;
}

export interface FunctionScopeInfo {
  readonly id: number;
  readonly name: string;
  readonly nameTokenIndex: number;
  readonly scopeId: number;
  readonly bodyStartToken: number;
  readonly bodyEndToken: number;
  readonly skipped: boolean;
  readonly fallbackReasons: readonly string[];
}

export interface PreservedToken {
  readonly tokenIndex: number;
  readonly reason: PreserveReason;
}

export interface ScopeFallbackInfo {
  readonly wholeModule: boolean;
  readonly reasons: readonly string[];
}

export interface ScopeAnalysis {
  readonly tokens: readonly Token[];
  readonly scopes: readonly ScopeFrameInfo[];
  readonly declarations: readonly ScopeDeclaration[];
  readonly references: readonly ScopeReference[];
  readonly functions: readonly FunctionScopeInfo[];
  readonly preservedTokens: readonly PreservedToken[];
  readonly fallback: ScopeFallbackInfo;
}

interface MutableScopeFrameInfo {
  id: number;
  kind: ScopeKind;
  parentId?: number;
  functionId?: number;
  startToken: number;
  endToken?: number;
}

interface MutableFunctionScopeInfo {
  id: number;
  name: string;
  nameTokenIndex: number;
  scopeId: number;
  bodyStartToken: number;
  bodyEndToken: number;
  skipped: boolean;
  fallbackReasons: string[];
}

interface ForScopeState {
  scopeId: number;
  headerDepth: number;
  awaitingBody: boolean;
  bodyDepth?: number;
}

const helperFunctionPattern = /^_vgsl_[0-9a-f]{8,16}__[A-Za-z_][A-Za-z0-9_]*$/;
const topLevelDeclarations = new Set(["fn", "struct", "const", "alias", "var", "override"]);

export function analyzeWgslScopes(source: string): ScopeAnalysis {
  return analyzeWgslTokens(scan(source));
}

export function analyzeWgslTokens(tokens: readonly Token[]): ScopeAnalysis {
  const walker = new ScopeWalker(tokens);
  return walker.analyze();
}

class ScopeWalker {
  private readonly scopes: MutableScopeFrameInfo[] = [];
  private readonly declarations: ScopeDeclaration[] = [];
  private readonly references: ScopeReference[] = [];
  private readonly functions: MutableFunctionScopeInfo[] = [];
  private readonly preserved = new Map<number, PreserveReason>();
  private readonly symbolsByScope = new Map<number, Map<string, number>>();
  private readonly moduleFallbackReasons: string[] = [];
  private readonly moduleScopeId: number;

  constructor(private readonly tokens: readonly Token[]) {
    this.moduleScopeId = this.createScope("module", undefined, undefined, 0);
  }

  analyze(): ScopeAnalysis {
    this.collectTopLevel();
    for (const fn of this.functions) this.walkFunction(fn);
    return {
      tokens: this.tokens,
      scopes: this.scopes,
      declarations: this.declarations,
      references: this.references,
      functions: this.functions,
      preservedTokens: [...this.preserved.entries()].map(([tokenIndex, reason]) => ({ tokenIndex, reason })),
      fallback: { wholeModule: this.moduleFallbackReasons.length > 0, reasons: this.moduleFallbackReasons },
    };
  }

  private collectTopLevel(): void {
    let depth = 0;
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (token.text === "{") { depth++; continue; }
      if (token.text === "}") { depth--; if (depth < 0) { this.moduleFallback("unmatched top-level closing brace", i); depth = 0; } continue; }
      if (depth !== 0) continue;

      if (token.text === "@") { i = this.preserveAttribute(i); continue; }
      if (token.text === "enable" || token.text === "requires" || token.text === "diagnostic" || token.text === "const_assert") { i = this.preserveStatement(i, "directive"); continue; }
      if (token.text === "export") continue;
      if (token.text === "struct") { i = this.collectStruct(i); continue; }
      if (token.text === "fn") { i = this.collectFunction(i); continue; }
      if (token.text === "const" || token.text === "alias" || token.text === "var" || token.text === "override") { i = this.preserveGlobalDeclaration(i); continue; }
      if (token.kind === "keyword" && !topLevelDeclarations.has(token.text)) this.moduleFallback(`unexpected top-level keyword '${token.text}'`, i);
    }
    if (depth !== 0) this.moduleFallback("unclosed top-level brace", this.tokens.length - 1);
    this.scopes[this.moduleScopeId]!.endToken = Math.max(0, this.tokens.length - 1);
  }

  private collectStruct(index: number): number {
    const name = this.nextSig(index);
    if (name === undefined || this.tokens[name]?.kind !== "ident") { this.moduleFallback("struct without name", index); return index; }
    this.preserveToken(name, "global");
    const open = this.nextSig(name);
    if (open === undefined || this.tokens[open]?.text !== "{") { this.moduleFallback("struct without body", index); return name; }
    const close = this.findMatching(open, "{", "}");
    if (close === undefined) { this.moduleFallback("unclosed struct body", open); return open; }
    for (let i = open; i <= close; i++) if (this.tokens[i]?.kind === "ident") this.preserveToken(i, "struct");
    return close;
  }

  private collectFunction(index: number): number {
    const nameIndex = this.nextSig(index);
    if (nameIndex === undefined || this.tokens[nameIndex]?.kind !== "ident") { this.moduleFallback("function without name", index); return index; }
    const name = this.tokens[nameIndex]!.text;
    const safeHelper = helperFunctionPattern.test(name) && !this.hasEntryAttributeBefore(index);
    const declId = this.addDeclaration(name, "function", nameIndex, this.moduleScopeId, undefined, safeHelper);
    if (!safeHelper) this.preserveToken(nameIndex, "global");

    const paramsOpen = this.nextSig(nameIndex);
    if (paramsOpen === undefined || this.tokens[paramsOpen]?.text !== "(") { this.moduleFallback("function without parameter list", nameIndex); return nameIndex; }
    const paramsClose = this.findMatching(paramsOpen, "(", ")");
    if (paramsClose === undefined) { this.moduleFallback("unclosed function parameter list", paramsOpen); return paramsOpen; }
    const bodyOpen = this.findNextText(paramsClose + 1, "{");
    if (bodyOpen === undefined) { this.moduleFallback("function without body", paramsClose); return paramsClose; }
    this.preserveFunctionSignatureTail(paramsClose + 1, bodyOpen);
    const bodyClose = this.findMatching(bodyOpen, "{", "}");
    if (bodyClose === undefined) { this.moduleFallback("unclosed function body", bodyOpen); return bodyOpen; }

    const fnScopeId = this.createScope("function", this.moduleScopeId, this.functions.length, paramsOpen);
    this.functions.push({ id: this.functions.length, name, nameTokenIndex: nameIndex, scopeId: fnScopeId, bodyStartToken: bodyOpen, bodyEndToken: bodyClose, skipped: false, fallbackReasons: [] });
    this.collectParams(paramsOpen, paramsClose, fnScopeId, this.functions.length - 1);
    this.scopes[fnScopeId]!.endToken = bodyClose;
    return bodyClose;
  }

  private collectParams(open: number, close: number, scopeId: number, functionId: number): void {
    for (let i = open + 1; i < close; i++) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (token.text === "@") { i = this.preserveAttribute(i); continue; }
      if (token.kind === "ident" && this.nextSig(i) !== undefined && this.tokens[this.nextSig(i)!]?.text === ":") {
        this.addDeclaration(token.text, "param", i, scopeId, functionId, true);
        const colon = this.nextSig(i)!;
        i = this.preserveTypeFrom(colon + 1, [",", ")"], close);
      }
    }
  }

  private preserveFunctionSignatureTail(start: number, bodyOpen: number): void {
    for (let i = start; i < bodyOpen; i++) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (token.text === "@") { i = this.preserveAttribute(i); continue; }
      if (token.kind === "ident") this.preserveToken(i, "type");
    }
  }

  private preserveGlobalDeclaration(index: number): number {
    let i = index + 1;
    if (this.tokens[index]?.text === "var") {
      const next = this.nextSig(index);
      if (next !== undefined && this.tokens[next]?.text === "<") {
        const end = this.findMatching(next, "<", ">");
        if (end === undefined) { this.moduleFallback("unparseable top-level var template", next); return next; }
        this.preserveRange(next, end, "type");
        i = end + 1;
      }
    }
    const name = this.findNextIdent(i);
    if (name !== undefined) {
      this.preserveToken(name, "global");
      this.addDeclaration(this.tokens[name]!.text, "global", name, this.moduleScopeId, undefined, false);
    }
    const end = this.findStatementEnd(index);
    for (let j = index; j <= end; j++) if (this.tokens[j]?.kind === "ident") this.preserveToken(j, "global");
    return end;
  }

  private walkFunction(fn: MutableFunctionScopeInfo): void {
    const scopeStack = [this.moduleScopeId, fn.scopeId];
    const forStates: ForScopeState[] = [];
    const pushScope = (kind: ScopeKind, start: number): number => {
      const id = this.createScope(kind, scopeStack[scopeStack.length - 1], fn.id, start);
      scopeStack.push(id);
      return id;
    };
    const popScope = (end: number): number | undefined => {
      if (scopeStack.length <= 2) { this.functionFallback(fn, "scope frame underflow", end); return undefined; }
      const id = scopeStack.pop()!;
      this.scopes[id]!.endToken = end;
      return id;
    };

    pushScope("block", fn.bodyStartToken);
    let blockDepth = 1;
    for (let i = fn.bodyStartToken + 1; i < fn.bodyEndToken; i++) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (token.text === "@") { i = this.preserveAttribute(i); continue; }
      if (token.text === ".") { const member = this.nextSig(i); if (member !== undefined && this.tokens[member]?.kind === "ident") this.preserveToken(member, "member"); continue; }
      if (token.text === "enable" || token.text === "requires" || token.text === "diagnostic") { i = this.preserveStatement(i, "directive"); continue; }
      if (token.text === "for") {
        const forScopeId = pushScope("for-init", i);
        const paren = this.nextSig(i);
        if (paren === undefined || this.tokens[paren]?.text !== "(") this.functionFallback(fn, "for without parenthesized header", i);
        forStates.push({ scopeId: forScopeId, headerDepth: 0, awaitingBody: false });
        continue;
      }

      const currentFor = forStates[forStates.length - 1];
      if (currentFor && currentFor.bodyDepth === undefined) {
        if (token.text === "(") currentFor.headerDepth++;
        if (token.text === ")") { currentFor.headerDepth--; if (currentFor.headerDepth <= 0) currentFor.awaitingBody = true; }
      }

      if (token.text === "{") {
        blockDepth++;
        const waitingFor = findLast(forStates, (item) => item.awaitingBody && item.bodyDepth === undefined);
        if (waitingFor) waitingFor.bodyDepth = blockDepth;
        pushScope("block", i);
        continue;
      }
      if (token.text === "}") {
        const closedDepth = blockDepth;
        popScope(i);
        blockDepth--;
        while (forStates.length > 0 && forStates[forStates.length - 1]!.bodyDepth === closedDepth) {
          popScope(i);
          forStates.pop();
        }
        if (blockDepth < 0) this.functionFallback(fn, "unmatched closing brace", i);
        continue;
      }

      if (token.text === ":") { i = this.preserveTypeFrom(i + 1, ["=", ";", ",", ")", "{"], fn.bodyEndToken); continue; }
      if (token.text === "-" && this.tokens[this.nextSig(i) ?? -1]?.text === ">") { i = this.preserveTypeFrom((this.nextSig(i) ?? i) + 1, ["{"], fn.bodyEndToken); continue; }

      if (token.text === "let" || token.text === "const" || token.text === "var") {
        i = this.collectLocalDeclaration(i, scopeStack[scopeStack.length - 1]!, fn);
        continue;
      }

      if (token.kind === "ident" && !this.preserved.has(i)) {
        const declId = this.resolve(token.text, scopeStack);
        if (declId !== undefined) this.references.push({ name: token.text, tokenIndex: i, declarationId: declId, scopeId: scopeStack[scopeStack.length - 1]!, functionId: fn.id });
        else this.preserveToken(i, "unknown");
      }
    }
    while (scopeStack.length > 2) popScope(fn.bodyEndToken);
  }

  private collectLocalDeclaration(index: number, scopeId: number, fn: MutableFunctionScopeInfo): number {
    const kind = this.tokens[index]!.text as "let" | "var" | "const";
    let cursor = index + 1;
    if (kind === "var") {
      const next = this.nextSig(index);
      if (next !== undefined && this.tokens[next]?.text === "<") {
        const end = this.findMatching(next, "<", ">");
        if (end === undefined) { this.functionFallback(fn, "unparseable var template", next); return next; }
        this.preserveRange(next, end, "type");
        cursor = end + 1;
      }
    }
    const nameIndex = this.findNextIdent(cursor);
    if (nameIndex === undefined || nameIndex >= fn.bodyEndToken) { this.functionFallback(fn, `${kind} without identifier`, index); return index; }
    this.addDeclaration(this.tokens[nameIndex]!.text, kind, nameIndex, scopeId, fn.id, true);
    const afterName = this.nextSig(nameIndex);
    if (afterName !== undefined && this.tokens[afterName]?.text === ":") return this.preserveTypeFrom(afterName + 1, ["=", ";", ",", ")"], fn.bodyEndToken);
    return nameIndex;
  }

  private addDeclaration(name: string, kind: DeclarationKind, tokenIndex: number, scopeId: number, functionId: number | undefined, safeToRename: boolean): number {
    const id = this.declarations.length;
    this.declarations.push({ id, name, kind, tokenIndex, scopeId, functionId, safeToRename });
    let symbols = this.symbolsByScope.get(scopeId);
    if (!symbols) { symbols = new Map(); this.symbolsByScope.set(scopeId, symbols); }
    if (!symbols.has(name)) symbols.set(name, id);
    return id;
  }

  private resolve(name: string, scopeStack: readonly number[]): number | undefined {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const found = this.symbolsByScope.get(scopeStack[i]!)?.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private preserveAttribute(index: number): number {
    this.preserveToken(index, "attribute");
    const name = this.nextSig(index);
    if (name === undefined) return index;
    this.preserveToken(name, "attribute");
    const next = this.nextSig(name);
    if (next === undefined || this.tokens[next]?.text !== "(") return name;
    const close = this.findMatching(next, "(", ")");
    if (close === undefined) { this.preserveRange(next, next, "attribute"); return next; }
    this.preserveRange(next, close, "attribute");
    return close;
  }

  private preserveTypeFrom(start: number, terminators: readonly string[], hardEnd: number): number {
    let angle = 0;
    let paren = 0;
    let bracket = 0;
    let last = start - 1;
    for (let i = start; i < hardEnd; i++) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (angle === 0 && paren === 0 && bracket === 0 && terminators.includes(token.text)) return Math.max(start - 1, i - 1);
      if (token.text === "<") angle++;
      else if (token.text === ">") angle = Math.max(0, angle - 1);
      else if (token.text === "(") paren++;
      else if (token.text === ")") { if (paren === 0 && terminators.includes(")")) return Math.max(start - 1, i - 1); paren = Math.max(0, paren - 1); }
      else if (token.text === "[") bracket++;
      else if (token.text === "]") bracket = Math.max(0, bracket - 1);
      if (token.kind === "ident") this.preserveToken(i, "type");
      last = i;
    }
    return last;
  }

  private preserveStatement(index: number, reason: PreserveReason): number {
    const end = this.findStatementEnd(index);
    this.preserveRange(index, end, reason);
    return end;
  }

  private preserveRange(start: number, end: number, reason: PreserveReason): void {
    for (let i = start; i <= end; i++) if (this.tokens[i] && this.tokens[i]!.kind !== "lineComment" && this.tokens[i]!.kind !== "blockComment") this.preserveToken(i, reason);
  }

  private preserveToken(index: number, reason: PreserveReason): void {
    if (!this.preserved.has(index)) this.preserved.set(index, reason);
  }

  private createScope(kind: ScopeKind, parentId: number | undefined, functionId: number | undefined, startToken: number): number {
    const id = this.scopes.length;
    this.scopes.push({ id, kind, parentId, functionId, startToken });
    return id;
  }

  private nextSig(index: number): number | undefined {
    for (let i = index + 1; i < this.tokens.length; i++) if (!isTrivia(this.tokens[i]!)) return i;
    return undefined;
  }

  private findNextIdent(index: number): number | undefined {
    for (let i = index; i < this.tokens.length; i++) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (token.kind === "ident") return i;
      if (token.text !== "@") return undefined;
    }
    return undefined;
  }

  private findNextText(index: number, text: string): number | undefined {
    for (let i = index; i < this.tokens.length; i++) if (!isTrivia(this.tokens[i]!) && this.tokens[i]!.text === text) return i;
    return undefined;
  }

  private findStatementEnd(index: number): number {
    let paren = 0;
    let angle = 0;
    for (let i = index; i < this.tokens.length; i++) {
      const text = this.tokens[i]!.text;
      if (text === "(") paren++;
      else if (text === ")") paren = Math.max(0, paren - 1);
      else if (text === "<") angle++;
      else if (text === ">") angle = Math.max(0, angle - 1);
      else if (paren === 0 && angle === 0 && (text === ";" || text === "{" || text === "}")) return i;
    }
    return this.tokens.length - 1;
  }

  private findMatching(openIndex: number, open: string, close: string): number | undefined {
    let depth = 0;
    for (let i = openIndex; i < this.tokens.length; i++) {
      const text = this.tokens[i]!.text;
      if (text === open) depth++;
      if (text === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return undefined;
  }

  private hasEntryAttributeBefore(fnIndex: number): boolean {
    for (let i = fnIndex - 1; i >= 0; i--) {
      const token = this.tokens[i]!;
      if (isTrivia(token)) continue;
      if (token.text === ")" || token.kind === "ident" || token.text === "@") {
        const text = token.text;
        if (text === "compute" || text === "vertex" || text === "fragment") return true;
        continue;
      }
      break;
    }
    return false;
  }

  private moduleFallback(reason: string, tokenIndex: number): void {
    this.moduleFallbackReasons.push(`${reason} at token ${tokenIndex}`);
  }

  private functionFallback(fn: MutableFunctionScopeInfo, reason: string, tokenIndex: number): void {
    fn.skipped = true;
    fn.fallbackReasons.push(`${reason} at token ${tokenIndex}`);
  }
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return items[i];
  return undefined;
}

function isTrivia(token: Token): boolean {
  return token.kind === "lineComment" || token.kind === "blockComment";
}
