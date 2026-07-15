import { ExampleCard } from '@/components/example-card';
import { examples } from '@/lib/examples-registry';

export default function ExamplesPage() {
  return (
    <div className="px-6 py-12 lg:px-12 lg:py-16">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10">
          <div className="mb-3 inline-flex rounded-full border border-blue-4 bg-blue-1 px-3 py-1 text-sm font-medium text-blue-9">
            Live WebGPU examples
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-gray-12 md:text-5xl">
            Examples
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-gray-9">
            Fullscreen shaders, compute pipelines, raw WebGPU interop, and read-only source files compiled directly by this docs app.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {examples.map((example) => (
            <ExampleCard key={example.meta.slug} example={example.meta} />
          ))}
        </div>
      </div>
    </div>
  );
}
