import { examples } from '@/lib/examples-registry';
import { ExampleCanvas } from './ExampleCanvas';

interface PreviewPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return examples.map((example) => ({ slug: example.meta.slug }));
}

export default async function PreviewPage({ params }: PreviewPageProps) {
  const { slug } = await params;
  return <ExampleCanvas slug={slug} />;
}
