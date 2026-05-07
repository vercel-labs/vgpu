export type MeshEditErrorCode = "NON_MANIFOLD" | "STALE_SELECTION" | "EMPTY_SELECTION" | "WRONG_DOMAIN" | "NOT_ORDERED" | "DEGENERATE_RESULT" | "AMBIGUOUS_TOPOLOGY" | "UNSUPPORTED_INPUT";
export class MeshEditError extends Error {
  readonly code: MeshEditErrorCode;
  readonly suggestion?: string;
  constructor(opts: { readonly code: MeshEditErrorCode; readonly message?: string; readonly suggestion?: string }) {
    super(opts.message ?? opts.code);
    this.name = "MeshEditError";
    this.code = opts.code;
    this.suggestion = opts.suggestion;
  }
}
