import Link from 'next/link';
import { DocsPageShell } from '@/components/docs-page-shell';
import { guideRecords, recordHref, titleForRecord } from '@/lib/manifest';

export default function GuidesPage() {
  return (
    <DocsPageShell pathname="/guides" articleClassName="min-w-0 max-w-5xl">
      <header className="mb-10">
        <p className="text-sm font-medium text-blue-9 mb-3">Guides</p>
        <h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">Guides</h1>
        <p className="text-xl text-gray-10 max-w-3xl">
          Task-oriented notes for performance, browser testing, measurement, and shader authoring.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {guideRecords.map((record) => (
          <Link
            key={record.symbol}
            href={recordHref(record)}
            className="group rounded-lg border border-gray-4 bg-gray-1 p-5 transition-all hover:border-gray-5 hover:bg-gray-2/50"
          >
            <h2 className="font-semibold text-gray-12 group-hover:text-blue-9 transition-colors">
              {titleForRecord(record)}
            </h2>
            <p className="mt-2 font-mono text-xs text-gray-9">{record.symbol}</p>
          </Link>
        ))}
      </div>
    </DocsPageShell>
  );
}
