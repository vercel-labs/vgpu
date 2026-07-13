import type { AddressSpace, AccessMode } from "./reflect-types.ts";
import type { Token } from "./scanner.ts";
import { splitGeneric, normalizeAccess } from "./reflect-utils.ts";
import { findNext } from "./reflect-token-utils.ts";

export function parseVarTemplate(tokens: readonly Token[], index: number): { addressSpace?: AddressSpace; access?: AccessMode; after: number } {
  if (tokens[index]?.text !== "<") return { after: index };
  const close = findNext(tokens, index, ">");
  const parts = splitGeneric(tokens.slice(index + 1, close)).map((part) => part.map((t) => t.text).join(""));
  return { addressSpace: parts[0] as AddressSpace | undefined, access: normalizeAccess(parts[1]), after: close + 1 };
}
