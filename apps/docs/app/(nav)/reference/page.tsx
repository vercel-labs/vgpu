import Link from 'next/link';
import { DocsPageShell } from '@/components/docs-page-shell';
import { referenceGroups, recordHref } from '@/lib/manifest';

const featuredSymbols = ['init', 'Gpu', 'Effect', 'Draw', 'Compute', 'Frame', 'Bundle', 'Target', 'SharedUniforms', 'PingPongStorage'];

export default function ReferencePage() {
  const allRecords = referenceGroups.flatMap((group) => group.records);
  const featuredRecords = featuredSymbols
    .map((symbol) => allRecords.find((record) => record.package === 'vgpu' && record.symbol === symbol))
    .filter((record): record is NonNullable<typeof record> => Boolean(record));

  return (
    <DocsPageShell pathname="/reference" articleClassName="min-w-0 max-w-6xl">
      <header className="mb-12">
        <p className="text-sm font-medium text-blue-9 mb-3">Reference</p>
        <h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">API Reference</h1>
        <p className="text-xl text-gray-10 max-w-3xl">
          Browse generated API docs by topic. Every symbol comes from the docs manifest and deep-links to an anchor on its topic page.
        </p>
      </header>

      <section className="mb-14">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Start with vgpu</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {featuredRecords.map((record) => (
            <Link
              key={record.symbol}
              href={recordHref(record)}
              className="group rounded-lg border border-gray-4 bg-gray-1 p-5 transition-all hover:border-gray-5 hover:bg-gray-2/50"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <code className="font-semibold text-gray-12">{record.symbol}</code>
                  <span className="inline-flex items-center rounded-full border border-gray-4 px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-9 leading-none">
                    {record.symbolKind}
                  </span>
                </div>
                <span className="text-gray-9 transition-colors group-hover:text-blue-9">→</span>
              </div>
              <p className="text-sm leading-6 text-gray-10">{record.summary}</p>
              {record.snippet ? (
                <pre className="mt-4 overflow-x-auto rounded-md border border-gray-4 bg-black/40 p-3 text-xs text-gray-11">
                  <code>{record.snippet}</code>
                </pre>
              ) : null}
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Packages</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {referenceGroups.map((group) => (
            <section
              key={group.packageName}
              id={group.packageSlug}
              className="scroll-mt-24 rounded-lg border border-gray-4 bg-gray-1 p-5"
            >
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-gray-12">{group.title}</h3>
                    {group.advanced ? (
                      <span className="rounded-full border border-yellow-4 bg-yellow-1 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-yellow-10">
                        Advanced
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-gray-10">{group.description}</p>
                </div>
                <span className="text-xs text-gray-9">{group.records.length} symbols</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.topics.map((topic) => (
                  <Link
                    key={topic.href}
                    href={topic.href}
                    className="group rounded-md border border-gray-4 bg-black/30 px-3 py-2 text-sm transition-colors hover:border-gray-5 hover:bg-gray-2/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-12 group-hover:text-blue-9">{topic.topicTitle}</span>
                      <span className="text-gray-9 group-hover:text-blue-9">→</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-9">{topic.records.length} symbols</div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </DocsPageShell>
  );
}
