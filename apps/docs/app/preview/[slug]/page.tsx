import { notFound } from 'next/navigation';
import { examplesMetadata } from '@/lib/examples-metadata';
import { isExampleSlug } from '@/lib/example-slugs';
import { ExampleCanvas } from './example-canvas';

interface PreviewPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return examplesMetadata.map((meta) => ({ slug: meta.slug }));
}

export default async function PreviewPage({ params }: PreviewPageProps) {
  const { slug } = await params;
  if (!isExampleSlug(slug)) notFound();
  return <ExampleCanvas slug={slug} />;
}
