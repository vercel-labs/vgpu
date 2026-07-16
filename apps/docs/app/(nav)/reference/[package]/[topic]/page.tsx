import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownContent } from '@/components/markdown-content';
import {
  getReferenceTopic,
  referenceTopics,
  sourceHref,
} from '@/lib/manifest';

interface ReferenceTopicPageProps {
  params: Promise<{ package: string; topic: string }>;
}

export function generateStaticParams() {
  return referenceTopics.map((topic) => ({
    package: topic.packageSlug,
    topic: topic.topic,
  }));
}

export async function generateMetadata({ params }: ReferenceTopicPageProps) {
  const { package: packageSlug, topic: topicSlug } = await params;
  const topic = getReferenceTopic(packageSlug, topicSlug);
  if (!topic) return {};
  return {
    title: `${topic.topicTitle} - ${topic.title} reference`,
    description: topic.records[0]?.summary ?? topic.description,
  };
}

export default async function ReferenceTopicPage({ params }: ReferenceTopicPageProps) {
  const { package: packageSlug, topic: topicSlug } = await params;
  const topic = getReferenceTopic(packageSlug, topicSlug);
  if (!topic) notFound();

  return (
    <article className="px-4 py-8 lg:px-8 lg:py-12 max-w-4xl mx-auto">
      <nav className="mb-8 flex flex-wrap items-center gap-2 text-sm text-gray-9">
        <Link href="/reference" className="hover:text-blue-9 transition-colors">Reference</Link>
        <span>/</span>
        <Link href={`/reference#${topic.packageSlug}`} className="hover:text-blue-9 transition-colors">{topic.title}</Link>
        <span>/</span>
        <span className="text-gray-11">{topic.topicTitle}</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-gray-4 bg-gray-1 px-3 py-1 text-xs font-medium text-gray-10">
          {topic.packageName}
        </span>
        {topic.advanced ? (
          <span className="rounded-full border border-yellow-4 bg-yellow-1 px-3 py-1 text-xs font-medium text-yellow-10">
            Advanced
          </span>
        ) : null}
        <span className="rounded-full border border-blue-4 bg-blue-1 px-3 py-1 text-xs font-medium text-blue-9">
          {topic.records.length} {topic.records.length === 1 ? 'symbol' : 'symbols'}
        </span>
        <a
          href={sourceHref(topic)}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-sm text-gray-9 hover:text-blue-9 transition-colors"
        >
          View source ↗
        </a>
      </div>

      <section className="mb-8 rounded-lg border border-gray-4 bg-gray-1 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-9">Symbols in this topic</h2>
        <div className="flex flex-wrap gap-2">
          {topic.records.map((record) => (
            <a
              key={`${record.package}:${record.symbol}`}
              id={record.anchor}
              href={`#${record.anchor}`}
              className="scroll-mt-24 rounded-full border border-gray-4 bg-black/30 px-3 py-1 text-sm text-gray-10 transition-colors hover:border-gray-5 hover:text-blue-9"
            >
              <code>{record.symbol}</code>
              <span className="ml-2 text-[11px] uppercase tracking-wide text-gray-8">{record.symbolKind}</span>
            </a>
          ))}
        </div>
      </section>

      <MarkdownContent content={topic.content} />
    </article>
  );
}
