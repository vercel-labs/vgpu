export const MANIFEST_VERSION = 2;

/** @typedef {"api" | "guide"} DocsKind */
/** @typedef {{ package: string, symbol: string, repoPath: string, virtualPath: string, content: string, kind: DocsKind }} DocsRecord */
/** @typedef {{ schemaVersion: 2, generatedFrom: string, records: DocsRecord[] }} DocsManifest */
/** @typedef {{ records: DocsRecord[], packages: string[], paths: Map<string, DocsRecord[]>, symbols: Map<string, DocsRecord[]> }} DocsIndex */
