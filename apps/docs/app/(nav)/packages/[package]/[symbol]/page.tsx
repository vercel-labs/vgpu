import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownContent } from '@/components/MarkdownContent';
import {
  apiRecords,
  getPackageGroup,
  getRecord,
  packageHref,
  recordHref,
  sourceHref,
  symbolToSlug,
  titleForRecord,
} from '@/lib/manifest';

interface SymbolPageProps {
  params: { package: string; symbol: string };
}

export function generateStaticParams() {
  return apiRecords.map((record) => ({
    package: record.package.replace(/^@/, '').replace(/[\/@]/g, '-'),
    symbol: symbolToSlug(record.symbol),
  }));
}

export function generateMetadata({ params }: SymbolPageProps) {
  const record = getRecord(params.package, params.symbol);
  if (!record || record.kind !== 'api') return {};
  return {
    title: `${record.symbol} - ${record.package}`,
    description: titleForRecord(record),
  };
}

export default function SymbolPage({ params }: SymbolPageProps) {
  const record = getRecord(params.package, params.symbol);
  if (!record || record.kind !== 'api') notFound();

  const group = getPackageGroup(params.package);
  const packageLabel = group?.title ?? record.package;

  return (
    <article className="px-4 py-8 lg:px-8 lg:py-12 max-w-4xl mx-auto">
      <nav className="mb-8 flex flex-wrap items-center gap-2 text-sm text-gray-9">
        <Link href="/packages" className="hover:text-blue-9 transition-colors">Packages</Link>
        <span>/</span>
        <Link href={packageHref(record.package)} className="hover:text-blue-9 transition-colors">{packageLabel}</Link>
        <span>/</span>
        <span className="text-gray-11">{record.symbol}</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-gray-4 bg-gray-1 px-3 py-1 text-xs font-medium text-gray-10">
          {record.package}
        </span>
        <span className="rounded-full border border-blue-4 bg-blue-1 px-3 py-1 text-xs font-medium text-blue-9">
          API reference
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
