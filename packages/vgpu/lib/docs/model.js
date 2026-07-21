export const MANIFEST_VERSION = 3;

/** @typedef {"api" | "guide"} DocsKind */
/** @typedef {"class" | "function" | "type" | "options"} DocsSymbolKind */
/** @typedef {{ package: string, symbol: string, repoPath: string, virtualPath: string, content: string, kind: DocsKind, summary: string, snippet: string, anchor: string, topic: string, topicTitle: string, symbolKind: DocsSymbolKind }} DocsRecord */
/** @typedef {{ schemaVersion: 3, generatedFrom: string, records: DocsRecord[] }} DocsManifest */
/** @typedef {{ records: DocsRecord[], packages: string[], paths: Map<string, DocsRecord[]>, symbols: Map<string, DocsRecord[]> }} DocsIndex */
