import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@vercel/geistdocs/components/button";
import { ExampleActions } from "@/components/example-actions";
import { ExamplePreview } from "@/components/example-preview";
import { ExampleSourceViewer } from "@/components/example-source-viewer";
import { translations } from "@/geistdocs";
// TGEIST-09: `examples`/`getExample` are the verbatim registry ported by
// TGEIST-07 (`lib/examples-registry.ts`) -- unmodified by this ticket.
import { examples, getExample } from "@/lib/examples-registry";
import { buildExamplePrompt, buildV0OpenUrl } from "@/lib/example-actions";
import { buildExampleSourceMarkdown } from "@/lib/example-readme";
import { localizedSitePath, SITE_OG_IMAGE_PATH, siteUrl } from "@/lib/site";

interface ExampleDetailPageProps {
  params: Promise<{ lang: string; slug: string }>;
}

export function generateStaticParams() {
  return Object.keys(translations).flatMap((lang) =>
    examples.map((example) => ({ lang, slug: example.meta.slug })),
  );
}

export async function generateMetadata({
  params,
}: ExampleDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const example = getExample(slug);
  if (!example) return {};

  return {
    title: example.meta.title,
    description: example.meta.description,
    alternates: {
      canonical: siteUrl(`/examples/${example.meta.slug}`),
      types: {
        "text/markdown": siteUrl(`/examples/${example.meta.slug}.md`),
      },
    },
    openGraph: {
      type: "article",
      title: example.meta.title,
      description: example.meta.description,
      url: siteUrl(`/examples/${example.meta.slug}`),
      images: example.meta.hero
        ? [siteUrl(example.meta.hero)]
        : [siteUrl(SITE_OG_IMAGE_PATH)],
    },
  };
}

const ExampleDetailPage = async ({ params }: ExampleDetailPageProps) => {
  const { lang, slug } = await params;
  const example = getExample(slug);
  if (!example) notFound();

  const prompt = buildExamplePrompt(example);
  const source = buildExampleSourceMarkdown(example);

  return (
    <main className="mx-auto w-full max-w-[880px] px-4 pt-12 pb-32 sm:px-6">
      <div className="mb-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <h1 className="font-medium! text-heading-32 text-gray-1000 tracking-tighter sm:text-heading-40">
            {example.meta.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0">
            {example.meta.guide ? (
              <Button asChild size="sm" variant="outline">
                <Link href={localizedSitePath(example.meta.guide, lang)}>Read guide</Link>
              </Button>
            ) : null}
            <Button asChild size="sm" variant="outline">
              <Link href={`/preview/${example.meta.slug}`}>Open fullscreen</Link>
            </Button>
            <ExampleActions
              downloadUrl={`/examples/${example.meta.slug}/download`}
              prompt={prompt}
              source={source}
              v0Url={buildV0OpenUrl(example)}
            />
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-copy-16 text-gray-900">
          {example.meta.description}
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <ExamplePreview slug={example.meta.slug} title={example.meta.title} />
        <ExampleSourceViewer files={example.sources} />
      </div>
    </main>
  );
};

export default ExampleDetailPage;
