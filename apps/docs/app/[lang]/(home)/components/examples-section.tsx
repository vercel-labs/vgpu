import DynamicLink from "fumadocs-core/dynamic-link";
import { exampleMetadataBySlug } from "@/lib/examples-metadata";
import { ExampleCard } from "./example-card";

const examplePool = [
  exampleMetadataBySlug["fft-ocean-surface"],
  exampleMetadataBySlug["radiance-cascades"],
  exampleMetadataBySlug.transmission,
  exampleMetadataBySlug["raymarched-fractal"],
  exampleMetadataBySlug["black-hole"],
  exampleMetadataBySlug["nextjs-flare"],
  exampleMetadataBySlug["depth-estimation"],
];

function selectExamples(count: number) {
  const shuffled = [...examplePool];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }

  return shuffled.slice(0, count);
}

export function ExamplesSection() {
  const featuredExamples = selectExamples(4);

  return (
    <section className="mb-36">
      <div className="mb-10 flex items-center justify-between gap-4">
        <h2 className="text-pretty text-2xl text-gray-1000 md:text-3xl">
          Browse examples
        </h2>
        <DynamicLink
          href="/[lang]/examples"
          className="text-sm text-gray-900 transition-colors hover:text-gray-1000"
          prefetch={false}
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
