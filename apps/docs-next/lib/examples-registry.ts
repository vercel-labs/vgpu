import 'server-only';

import { exampleSources } from './examples-source.generated';
import { examplesMetadata } from './examples-metadata';

export interface ExampleSourceFile {
  readonly name: string;
  readonly lang: string;
  readonly code: string;
}

export interface ExampleRecord {
  readonly meta: (typeof examplesMetadata)[number];
  readonly sources: readonly ExampleSourceFile[];
}

export const examples = examplesMetadata.map((meta) => ({
  meta,
  sources: (exampleSources[meta.slug]?.files ?? []).map((file) => ({
    name: file.path,
    lang: file.language,
    code: file.content,
  })),
})) satisfies readonly ExampleRecord[];

export function getExample(slug: string): ExampleRecord | undefined {
  return examples.find((example) => example.meta.slug === slug);
}
