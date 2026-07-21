import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownContent } from '@/components/markdown-content';
import { getContentPage, collectionSlugs } from '@/lib/concepts';
import { apiRecords, recordHref } from '@/lib/manifest';

interface GetStartedPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return collectionSlugs('get-started').map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: GetStartedPageProps) {
  const { slug } = await params;
  const page = getContentPage('get-started', slug);
  if (!page) return {};
  return {
    title: page.frontmatter.title,
    description: page.frontmatter.summary,
  };
}

export default async function GetStartedSlugPage({ params }: GetStartedPageProps) {
  const { slug } = await params;
  const page = getContentPage('get-started', slug);
  if (!page) notFound();

  const { frontmatter, headings } = page;
  const relatedApi = frontmatter.relatedSymbols.map((symbol) => ({
    symbol,
    record: apiRecords.find((record) => record.package === 'vgpu' && record.symbol === symbol)
      ?? apiRecords.find((record) => record.symbol === symbol),
  }));

  return (
    <article className="px-4 py-8 lg:px-8 lg:py-12 max-w-6xl mx-auto">
      <nav className="mb-8 flex flex-wrap items-center gap-2 text-sm text-gray-9">
        <Link href="/get-started" className="hover:text-blue-9 transition-colors">Get started</Link>
        <span>/</span>
        <span className="text-gray-11">{frontmatter.title}</span>
      </nav>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 max-w-4xl">
          <MarkdownContent content={page.content} enableTwoslashCut />

          {frontmatter.relatedSymbols.length > 0 ? (
            <section className="mt-12 rounded-lg border border-gray-4 bg-gray-1 p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-9">API in this chapter</h2>
              <div className="flex flex-wrap gap-2">
                {relatedApi.map(({ symbol, record }) => record ? (
                  <Link
                    key={symbol}
                    href={recordHref(record)}
                    className="rounded-full border border-gray-4 bg-black/30 px-3 py-1 text-sm text-gray-10 transition-colors hover:border-gray-5 hover:text-blue-9"
                  >
                    <code>{symbol}</code>
                  </Link>
                ) : (
                  <span key={symbol} className="rounded-full border border-gray-4 bg-black/30 px-3 py-1 text-sm text-gray-10">
                    <code>{symbol}</code>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {frontmatter.prevNext?.prev || frontmatter.prevNext?.next ? (
            <nav className="mt-10 grid gap-3 sm:grid-cols-2" aria-label="Get started navigation">
              {frontmatter.prevNext.prev ? (
                <Link href={frontmatter.prevNext.prev.href} className="rounded-lg border border-gray-4 bg-gray-1 p-4 transition-colors hover:border-gray-5 hover:bg-gray-2">
                  <span className="block text-xs uppercase tracking-wider text-gray-8">Previous</span>
                  <span className="mt-1 block text-gray-12">{frontmatter.prevNext.prev.title}</span>
                </Link>
              ) : <div />}
              {frontmatter.prevNext.next ? (
                <Link href={frontmatter.prevNext.next.href} className="rounded-lg border border-gray-4 bg-gray-1 p-4 text-right transition-colors hover:border-gray-5 hover:bg-gray-2">
                  <span className="block text-xs uppercase tracking-wider text-gray-8">Next</span>
                  <span className="mt-1 block text-gray-12">{frontmatter.prevNext.next.title}</span>
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-8 rounded-lg border border-gray-4 bg-gray-1 p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-9">On this page</h2>
            <nav className="space-y-2 text-sm">
              {headings.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  className={`block text-gray-9 transition-colors hover:text-blue-9 ${heading.level === 3 ? 'pl-4' : ''}`}
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          </div>
        </aside>
      </div>
    </article>
  );
}
