import Link from 'next/link';
import { getConceptPage } from '@/lib/concepts';

export const metadata = {
  title: 'Concepts',
  description: 'The core ideas behind every vgpu program, in reading order.',
};

const order = ['context', 'draws', 'compilation', 'effects', 'passes', 'frames', 'render-bundles'];

export default function ConceptsPage() {
  const pages = order
    .map((slug) => ({ slug, page: getConceptPage(slug) }))
    .filter((entry): entry is { slug: string; page: NonNullable<ReturnType<typeof getConceptPage>> } => entry.page !== null);

  return (
    <article className="px-4 py-8 lg:px-8 lg:py-12 max-w-6xl mx-auto">
      <h1 className="text-3xl font-semibold text-gray-12">Concepts</h1>
      <p className="mt-4 max-w-2xl leading-7 text-gray-11">
        These ideas cover every vgpu program. Read them in order — each page builds on the previous one.
      </p>

      <div className="mt-8 grid gap-3">
        {pages.map(({ slug, page }) => (
          <Link
            key={slug}
            href={`/concepts/${slug}`}
            className="flex flex-col gap-1 rounded-lg border border-gray-4 bg-gray-1 p-4 transition-colors hover:border-gray-5 hover:bg-gray-2 sm:flex-row sm:items-baseline sm:gap-3"
          >
            <span className="font-medium text-gray-12">{page.frontmatter.title}</span>
            <span className="text-sm text-gray-10">{page.frontmatter.summary}</span>
          </Link>
        ))}
      </div>
    </article>
  );
}
