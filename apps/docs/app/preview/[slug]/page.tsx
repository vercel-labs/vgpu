import { examples } from '@/lib/examples-registry';
import { ExampleCanvas } from './ExampleCanvas';

interface PreviewPageProps {
  params: { slug: string };
}

export function generateStaticParams() {
  return examples.map((example) => ({ slug: example.meta.slug }));
}

export default function PreviewPage({ params }: PreviewPageProps) {
  return <ExampleCanvas slug={params.slug} />;
}
