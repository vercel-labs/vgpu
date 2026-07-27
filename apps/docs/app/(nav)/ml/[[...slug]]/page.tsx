import { notFound } from 'next/navigation';
import { DocsPageShell } from '@/components/docs-page-shell';
import { extractToc, MarkdownContent } from '@/components/markdown-content';
import { docsRecords, getDocsRecordByWebsitePath, sourceHref, stripMarkdownFrontmatter, titleForRecord } from '@/lib/manifest';

interface MlPageProps {
  params: Promise<{ slug?: string[] }>;
}

function websitePathFor(slug?: string[]) {
  return slug?.length ? `/ml/${slug.join('/')}` : '/ml';
}

export function generateStaticParams() {
  return docsRecords.flatMap((record) => {
    const websitePath = record.websitePath;
    if (websitePath !== '/ml' && !websitePath?.startsWith('/ml/')) return [];
    return [{ slug: websitePath === '/ml' ? [] : websitePath.slice('/ml/'.length).split('/') }];
  });
}

export async function generateMetadata({ params }: MlPageProps) {
  const { slug } = await params;
  const record = getDocsRecordByWebsitePath(websitePathFor(slug));
  if (!record) return {};
  return {
    title: titleForRecord(record),
    description: record.summary,
  };
}

export default async function MlPage({ params }: MlPageProps) {
  const { slug } = await params;
  const pathname = websitePathFor(slug);
  const record = getDocsRecordByWebsitePath(pathname);
  if (!record) notFound();

  const content = stripMarkdownFrontmatter(record.content);

  return (
    <DocsPageShell pathname={pathname} toc={extractToc(content)}>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-blue-4 bg-blue-1 px-3 py-1 text-xs font-medium text-blue-9">
          ML
        </span>
        <a
          href={sourceHref(record)}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-sm text-gray-9 hover:text-blue-9 transition-colors"
        >
          View source ↗
        </a>
      </div>

      <MarkdownContent content={content} />
    </DocsPageShell>
  );
}
