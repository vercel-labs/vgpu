export interface WgslToken {
  readonly kind: "identifier" | "token";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const pairedTokens = new Set([
  "->", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
]);

export function scanWgslTokens(source: string): readonly WgslToken[] {
  const tokens: WgslToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor]!)) { cursor++; continue; }
    if (source.startsWith("//", cursor)) {
      cursor = source.indexOf("\n", cursor + 2);
      if (cursor === -1) break;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (source[cursor] === '"' || source[cursor] === "'") {
      cursor = skipString(source, cursor);
      continue;
    }

    const start = cursor;
    if (/[A-Za-z_]/u.test(source[cursor]!)) {
      cursor++;
      while (/[A-Za-z0-9_]/u.test(source[cursor] ?? "")) cursor++;
      tokens.push({ kind: "identifier", text: source.slice(start, cursor), start, end: cursor });
      continue;
    }

    const pair = source.slice(cursor, cursor + 2);
    cursor += pairedTokens.has(pair) ? 2 : 1;
    tokens.push({ kind: "token", text: source.slice(start, cursor), start, end: cursor });
  }
  return tokens;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") { cursor += 2; continue; }
    if (source[cursor] === quote) return cursor + 1;
    cursor++;
  }
  return cursor;
}

function skipBlockComment(source: string, start: number): number {
  let cursor = start;
  let depth = 0;
  while (cursor < source.length) {
    if (source.startsWith("/*", cursor)) { depth++; cursor += 2; continue; }
    if (source.startsWith("*/", cursor)) {
      depth--;
      cursor += 2;
      if (depth === 0) return cursor;
      continue;
    }
    cursor++;
  }
  return cursor;
}
