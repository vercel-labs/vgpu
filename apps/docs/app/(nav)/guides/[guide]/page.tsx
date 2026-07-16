import { notFound } from 'next/navigation';
import { DocsPageShell } from '@/components/docs-page-shell';
import { extractToc, MarkdownContent } from '@/components/markdown-content';
import { getGuideRecord, guideRecords, sourceHref, symbolToSlug, titleForRecord } from '@/lib/manifest';

interface GuidePageProps {
  params: Promise<{ guide: string }>;
}

export function generateStaticParams() {
  return guideRecords.map((record) => ({ guide: symbolToSlug(record.symbol) }));
}

export async function generateMetadata({ params }: GuidePageProps) {
  const { guide } = await params;
  const record = getGuideRecord(guide);
  if (!record) return {};
  return {
    title: titleForRecord(record),
    description: `Guide: ${record.symbol}`,
  };
}

export default async function GuidePage({ params }: GuidePageProps) {
  const { guide } = await params;
  const record = getGuideRecord(guide);
  if (!record) notFound();

  const pathname = `/guides/${record.symbol}`;

  return (
    <DocsPageShell pathname={pathname} toc={extractToc(record.content)}>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-blue-4 bg-blue-1 px-3 py-1 text-xs font-medium text-blue-9">
          Guide
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

      <MarkdownContent content={record.content} />
    </DocsPageShell>
  );
}
