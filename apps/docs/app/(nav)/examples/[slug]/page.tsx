import Link from 'next/link';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { PageNavigation } from '@/components/page-navigation';
import { notFound } from 'next/navigation';
import { CodeViewer } from '@/components/code-viewer';
import { ExamplePreview } from '@/components/example-preview';
import { examples, getExample } from '@/lib/examples-registry';
import { getBreadcrumbs, getPrevNext } from '@/lib/nav';

interface ExampleDetailPageProps {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ file?: string }>;
}

export function generateStaticParams() {
  return examples.map((example) => ({ slug: example.meta.slug }));
}

export default async function ExampleDetailPage({ params, searchParams }: ExampleDetailPageProps) {
  const { slug } = await params;
  const { file: activeFile } = (await searchParams) ?? {};
  const example = getExample(slug);
  if (!example) notFound();

  const pathname = `/examples/${example.meta.slug}`;
  const { prev, next } = getPrevNext(pathname);

  return (
    <div className="px-6 py-8 lg:px-8 xl:px-12">
      <div className="mx-auto max-w-[1500px]">
        <Breadcrumbs items={getBreadcrumbs(pathname)} />
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-12 md:text-4xl">
              {example.meta.title}
            </h1>
            <p className="mt-3 max-w-2xl text-gray-9">
              {example.meta.description}
            </p>
          </div>
          <Link
            href={`/preview/${example.meta.slug}`}
            className="rounded-lg border border-gray-4 bg-gray-2 px-4 py-2 text-sm font-medium text-gray-12 transition-colors hover:border-gray-5 hover:bg-gray-1"
          >
            Open fullscreen
          </Link>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
          <section>
            <CodeViewer files={example.sources} activeFile={activeFile} />
          </section>

          <section>
            <ExamplePreview slug={example.meta.slug} title={example.meta.title} poster={example.meta.hero} />
          </section>
        </div>
        <PageNavigation prev={prev} next={next} />
      </div>
    </div>
  );
}
