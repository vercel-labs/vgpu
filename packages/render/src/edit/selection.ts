import type { ElementDomain, ElementSelection, ScoredSelection } from "./types.ts";

export function selection(domain: ElementDomain, indices: readonly number[], ordered = false): ElementSelection {
  const out = ordered ? [...indices] : [...new Set(indices)].sort((a, b) => a - b);
  return Object.freeze({ domain, indices: Object.freeze(out), count: out.length, ...(ordered ? { ordered: true } : {}) });
}

export class MeshScoredSelection implements ScoredSelection {
  readonly entries: ReadonlyArray<{ readonly index: number; readonly score: number }>;
  constructor(readonly domain: ElementDomain, entries: readonly { readonly index: number; readonly score: number }[]) {
    this.entries = Object.freeze([...entries].sort((a, b) => b.score - a.score || a.index - b.index));
  }
  top(): ElementSelection { return this.topN(1); }
  topN(n: number): ElementSelection { return selection(this.domain, this.entries.slice(0, Math.max(0, n)).map((e) => e.index)); }
  threshold(min: number): ElementSelection { return selection(this.domain, this.entries.filter((e) => e.score >= min).map((e) => e.index)); }
  bottom(): ElementSelection { return this.bottomN(1); }
  bottomN(n: number): ElementSelection {
    const out = [...this.entries].sort((a, b) => a.score - b.score || a.index - b.index).slice(0, Math.max(0, n));
    return selection(this.domain, out.map((e) => e.index));
  }
}
