import { adapterError } from "./errors.ts";
import { scanWgslTokens, type WgslToken } from "./wgsl-tokens.ts";

export interface FunctionSignature {
  readonly name: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly type: string;
  }[];
  readonly returnType: string;
}

export function readFunctionSignature(
  source: string,
  name: string,
  metadataIsAuthoritative: boolean,
): FunctionSignature {
  const tokens = scanWgslTokens(source);
  const declarations = findFunctionDeclarations(tokens, name, metadataIsAuthoritative);

  if (declarations.length === 0) {
    const code = metadataIsAuthoritative
      ? "VGPU-THREE-TSL-SOURCE-INVALID"
      : "VGPU-THREE-TSL-EXPORT-NOT-FOUND";
    throw adapterError(code, `WGSL module has no function named ${name}.`);
  }
  if (declarations.length > 1) {
    const code = metadataIsAuthoritative
      ? "VGPU-THREE-TSL-SOURCE-INVALID"
      : "VGPU-THREE-TSL-EXPORT-AMBIGUOUS";
    throw adapterError(code, `WGSL module has multiple functions answering to ${name}.`);
  }

  const declaration = declarations[0]!;
  if (hasShaderStageAttribute(tokens, declaration.fnIndex)) {
    throw adapterError(
      "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
      `WGSL function ${name} cannot be forwarded through Three TSL.`,
    );
  }

  const parametersOpen = declaration.parametersOpen;
  const parametersClose = matchingToken(tokens, parametersOpen, "(", ")");
  if (parametersClose === -1) {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      `WGSL function ${name} has an unbalanced parameter list.`,
    );
  }

  const returnType = readReturnType(tokens, parametersClose + 1, name);
  const parameters = readParameters(
    tokens,
    parametersOpen + 1,
    parametersClose,
    name,
  );

  return { name: declaration.name, parameters, returnType };
}

interface FunctionDeclaration {
  readonly name: string;
  readonly fnIndex: number;
  readonly parametersOpen: number;
}

function findFunctionDeclarations(
  tokens: readonly WgslToken[],
  requestedName: string,
  metadataIsAuthoritative: boolean,
): readonly FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.text === "{") { depth++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 || token.text !== "fn") continue;

    const declaredName = tokens[index + 1];
    if (declaredName?.kind !== "identifier" || tokens[index + 2]?.text !== "(") continue;
    if (!answersTo(declaredName.text, requestedName, metadataIsAuthoritative)) continue;
    declarations.push({
      name: declaredName.text,
      fnIndex: index,
      parametersOpen: index + 2,
    });
  }
  return declarations;
}

function answersTo(declaredName: string, requestedName: string, exact: boolean): boolean {
  if (declaredName === requestedName) return true;
  if (exact) return false;
  const legacyPrefix = /^_vgsl_[0-9a-f]{8}__/u.exec(declaredName)?.[0];
  return legacyPrefix !== undefined && declaredName.slice(legacyPrefix.length) === requestedName;
}

function readReturnType(
  tokens: readonly WgslToken[],
  start: number,
  functionName: string,
): string {
  let cursor = start;
  if (tokens[cursor]?.text === "{") {
    throw adapterError(
      "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
      `WGSL function ${functionName} does not return a value.`,
    );
  }
  if (tokens[cursor]?.text !== "->") {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      `WGSL function ${functionName} has a malformed return type or no body.`,
    );
  }

  cursor++;
  if (tokens[cursor]?.text === "@") {
    throw adapterError(
      "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
      `WGSL function ${functionName} cannot be forwarded through Three TSL.`,
    );
  }
  const typeStart = cursor;
  if (tokens[typeStart]?.kind !== "identifier") {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      `WGSL function ${functionName} has a malformed return type.`,
    );
  }
  cursor++;

  if (tokens[cursor]?.text === "<") {
    const templateEnd = matchingTemplate(tokens, cursor);
    if (templateEnd === -1) {
      throw adapterError(
        "VGPU-THREE-TSL-SOURCE-INVALID",
        `WGSL function ${functionName} has a malformed return type.`,
      );
    }
    cursor = templateEnd + 1;
  }

  const bodyStart = tokens[cursor];
  if (bodyStart?.text !== "{") {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      `WGSL function ${functionName} has a malformed return type or no body.`,
    );
  }
  return normalizedTokenText(tokens.slice(typeStart, cursor));
}

function readParameters(
  tokens: readonly WgslToken[],
  start: number,
  end: number,
  functionName: string,
): readonly { readonly name: string; readonly type: string }[] {
  if (start === end) return [];

  const segments: Array<readonly [number, number]> = [];
  let segmentStart = start;
  const nesting: string[] = [];

  for (let cursor = start; cursor < end; cursor++) {
    if (!updateNesting(nesting, tokens, cursor)) {
      throw adapterError(
        "VGPU-THREE-TSL-SOURCE-INVALID",
        `WGSL function ${functionName} has malformed parameters.`,
      );
    }
    if (tokens[cursor]?.text === "," && nesting.length === 0) {
      segments.push([segmentStart, cursor]);
      segmentStart = cursor + 1;
    }
  }

  if (nesting.length !== 0) {
    throw adapterError(
      "VGPU-THREE-TSL-SOURCE-INVALID",
      `WGSL function ${functionName} has malformed parameters.`,
    );
  }
  if (segmentStart < end) segments.push([segmentStart, end]);

  return segments.map(([segmentStart, segmentEnd]) => {
    let colonIndex = segmentStart;
    while (colonIndex < segmentEnd && tokens[colonIndex]?.text !== ":") colonIndex++;
    const nameToken = tokens[colonIndex - 1];
    const name = nameToken?.kind === "identifier" && colonIndex > segmentStart
      ? nameToken.text
      : "";
    const type = colonIndex === segmentEnd
      ? ""
      : normalizedTokenText(tokens.slice(colonIndex + 1, segmentEnd));
    if (name === "" || type === "") {
      throw adapterError(
        "VGPU-THREE-TSL-SOURCE-INVALID",
        `WGSL function ${functionName} has malformed parameters.`,
      );
    }
    return { name, type };
  });
}

function normalizedTokenText(tokens: readonly WgslToken[]): string {
  const first = tokens[0];
  if (first === undefined) return "";
  let result = first.text;
  for (let index = 1; index < tokens.length; index++) {
    const previous = tokens[index - 1]!;
    const current = tokens[index]!;
    if (current.start > previous.end) result += " ";
    result += current.text;
  }
  return result;
}

function matchingToken(
  tokens: readonly WgslToken[],
  openAt: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let cursor = openAt; cursor < tokens.length; cursor++) {
    if (tokens[cursor]?.text === open) depth++;
    else if (tokens[cursor]?.text === close && --depth === 0) return cursor;
  }
  return -1;
}

function matchingTemplate(tokens: readonly WgslToken[], openAt: number): number {
  const nesting: string[] = [];
  for (let cursor = openAt; cursor < tokens.length; cursor++) {
    if (!updateNesting(nesting, tokens, cursor)) return -1;
    if (nesting.length === 0) return cursor;
  }
  return -1;
}

function updateNesting(
  nesting: string[],
  tokens: readonly WgslToken[],
  cursor: number,
): boolean {
  const text = tokens[cursor]!.text;
  if (text === "(" || text === "[") { nesting.push(text); return true; }
  if (opensTemplate(nesting, tokens, cursor)) {
    nesting.push(text);
    return true;
  }
  if (text === ")") return popExpected(nesting, "(");
  if (text === "]") return popExpected(nesting, "[");
  if (text === ">" && nesting.at(-1) === "<") { nesting.pop(); return true; }
  if (text === ">>" && nesting.at(-1) === "<" && nesting.at(-2) === "<") {
    nesting.pop();
    nesting.pop();
  }
  return true;
}

function opensTemplate(
  nesting: readonly string[],
  tokens: readonly WgslToken[],
  cursor: number,
): boolean {
  if (tokens[cursor]?.text !== "<" || tokens[cursor - 1]?.kind !== "identifier") return false;
  const enclosing = nesting.at(-1);
  return enclosing !== "(" && enclosing !== "[";
}

function popExpected(nesting: string[], expected: string): boolean {
  if (nesting.at(-1) !== expected) return false;
  nesting.pop();
  return true;
}

function hasShaderStageAttribute(tokens: readonly WgslToken[], fnIndex: number): boolean {
  for (let index = fnIndex - 1; index >= 0; index--) {
    const text = tokens[index]!.text;
    if (text === ";" || text === "{" || text === "}") return false;
    if (["vertex", "fragment", "compute"].includes(text) && tokens[index - 1]?.text === "@") {
      return true;
    }
  }
  return false;
}
