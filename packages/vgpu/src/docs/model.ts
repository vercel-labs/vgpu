export interface DocsRecord {
  package: string;
  symbol: string;
  repoPath: string;
  virtualPath: string;
  content: string;
}

export interface DocsManifest {
  schemaVersion: 1;
  formatVersion: string;
  records: DocsRecord[];
}

export interface DocsIndex {
  manifest: DocsManifest;
  records: DocsRecord[];
  paths: Map<string, DocsRecord[]>;
  symbols: Map<string, DocsRecord[]>;
  packages: string[];
}

export interface CommandResult {
  code: number;
  stdout?: string;
  stderr?: string;
}
