import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownContent } from '@/components/MarkdownContent';
import { getGuideRecord, guideRecords, sourceHref, symbolToSlug, titleForRecord } from '@/lib/manifest';

interface GuidePageProps {
  params: { guide: string };
}

export function generateStaticParams() {
  return guideRecords.map((record) => ({ guide: symbolToSlug(record.symbol) }));
}

export function generateMetadata({ params }: GuidePageProps) {
  const record = getGuideRecord(params.guide);
  if (!record) return {};
  return {
    title: titleForRecord(record),
    description: `Guide: ${record.symbol}`,
  };
}

export default function GuidePage({ params }: GuidePageProps) {
  const record = getGuideRecord(params.guide);
  if (!record) notFound();

  return (
    <article className="px-4 py-8 lg:px-8 lg:py-12 max-w-4xl mx-auto">
      <nav className="mb-8 flex flex-wrap items-center gap-2 text-sm text-gray-9">
        <Link href="/guides" className="hover:text-blue-9 transition-colors">Guides</Link>
        <span>/</span>
        <span className="text-gray-11">{record.symbol}</span>
      </nav>

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
    </article>
  );
}
