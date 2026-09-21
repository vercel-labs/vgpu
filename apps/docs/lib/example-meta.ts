import type { ExampleSlug } from './example-slugs';

export interface ExampleThumbOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
  readonly note?: string;
  readonly requiredLimits?: Readonly<Record<string, number>>;
}

/** Data-only contract for a migrated example's meta.ts export. */
export interface ExampleMetaDefinition {
  readonly slug: ExampleSlug;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly guide?: string;
  readonly capabilities: readonly string[];
  readonly files: readonly string[];
  readonly thumb?: ExampleThumbOptions;
}

export interface ExampleMeta extends ExampleMetaDefinition {
  readonly thumbnail?: string;
  readonly hero?: string;
}
