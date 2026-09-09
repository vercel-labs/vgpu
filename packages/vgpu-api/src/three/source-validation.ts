import { adapterError } from "./errors.ts";
import { scanWgslTokens, type WgslToken } from "./wgsl-tokens.ts";

export const privateNamespacePrefix = "_vgpu_three_";
const moduleDirectives = ["diagnostic", "enable", "requires"];
const namedDeclarationKinds = new Set(["alias", "const", "fn", "override", "struct", "var"]);

export function assertSourceSupported(source: string): void {
  const tokens = scanWgslTokens(source);
  let nestingDepth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if ("([{".includes(token.text)) {
      nestingDepth++;
      continue;
    }
    if (")]}".includes(token.text)) {
      nestingDepth = Math.max(0, nestingDepth - 1);
      continue;
    }
    if (nestingDepth > 0) continue;

    if (moduleDirectives.includes(token.text) && tokens[index - 1]?.text !== "@") {
      throw adapterError(
        "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
        `Three TSL cannot place '${token.text}' before declarations.`,
      );
    }
    if (!namedDeclarationKinds.has(token.text)) continue;

    const name = declarationName(tokens, index);
    if (name?.text.startsWith(privateNamespacePrefix)) {
      throw adapterError(
        "VGPU-THREE-TSL-SOURCE-INVALID",
        `WGSL declaration ${name.text} uses the private ${privateNamespacePrefix} namespace.`,
      );
    }
  }
}

function declarationName(tokens: readonly WgslToken[], kindIndex: number): WgslToken | undefined {
  let index = kindIndex + 1;
  if (tokens[kindIndex]?.text === "var" && tokens[index]?.text === "<") {
    index = afterAngleList(tokens, index);
  }
  return tokens[index]?.kind === "identifier" ? tokens[index] : undefined;
}

function afterAngleList(tokens: readonly WgslToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index]?.text === "<") depth++;
    else if (tokens[index]?.text === ">" && --depth === 0) return index + 1;
  }
  return tokens.length;
}
