import DynamicLink from 'fumadocs-core/dynamic-link';
import { InlineCode } from './inline-code';

// Same copy as the old landing (apps/docs/app/page.tsx:docLinks).
const docLinks: [href: string, title: string, description: string][] = [
  ['/docs/get-started', 'Getting Started', 'Install `vgpu` and render with `init()`.'],
  ['/docs/concepts', 'Core Concepts', 'Learn Gpu, set(), targets, frames, bundles, and adapters.'],
  ['/docs/reference', 'API Reference', 'Package map and generated topic pages.'],
  ['/examples', 'Examples', 'Live WebGPU demos with read-only source views.'],
];

export function DocsLinksSection() {
  return (
    <section className="mb-24">
      <h2 className="mb-10 text-2xl text-gray-12 md:text-3xl">Explore the Docs</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {docLinks.map(([href, title, description]) => (
          <DynamicLink
            key={href}
            href={`/[lang]${href}`}
            className="group rounded-lg border border-gray-4 bg-gray-1 p-6 transition-all hover:border-gray-5"
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-gray-12 transition-colors group-hover:text-blue-9">{title} →</h3>
            </div>
            <p className="text-sm text-gray-9">
              <InlineCode text={description} />
            </p>
          </DynamicLink>
        ))}
      </div>
    </section>
  );
}
