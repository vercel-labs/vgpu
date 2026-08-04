import DynamicLink from 'fumadocs-core/dynamic-link';
import { exampleMetadataBySlug } from '@/lib/examples-metadata';
import { ExampleCard } from './example-card';

// Same four featured slugs as the old landing
// (apps/docs/app/page.tsx:featuredExamples) — copy/curation unchanged.
const featuredExamples = [
  exampleMetadataBySlug['black-hole'],
  exampleMetadataBySlug['raymarched-fractal'],
  exampleMetadataBySlug['fft-ocean'],
  exampleMetadataBySlug['triangle-led-front'],
];

export function ExamplesSection() {
  return (
    <section className="mb-24 mt-24">
      <div className="mb-10 flex items-center justify-between gap-4">
        <h2 className="text-2xl text-gray-12 md:text-3xl">Examples</h2>
        <DynamicLink
          href="/[lang]/examples"
          className="text-sm text-gray-9 transition-colors hover:text-gray-12"
        >
          View all →
        </DynamicLink>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {featuredExamples.map((example) => (
          <ExampleCard key={example.slug} example={example} />
        ))}
      </div>
    </section>
  );
}
