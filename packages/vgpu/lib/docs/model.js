export const MANIFEST_VERSION = 1;

/** @typedef {{ package: string, symbol: string, repoPath: string, virtualPath: string, content: string }} DocsRecord */
/** @typedef {{ schemaVersion: 1, generatedFrom: string, records: DocsRecord[] }} DocsManifest */
/** @typedef {{ records: DocsRecord[], packages: string[], paths: Map<string, DocsRecord[]>, symbols: Map<string, DocsRecord[]> }} DocsIndex */
