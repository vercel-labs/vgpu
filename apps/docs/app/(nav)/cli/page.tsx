import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsPageShell } from '@/components/docs-page-shell';
import { extractToc, MarkdownContent } from '@/components/markdown-content';
import { getDocsTopicPage } from '@/lib/concepts';

export function generateMetadata(): Metadata {
  const page = getDocsTopicPage('cli');
  return {
    title: page?.frontmatter.title ?? 'CLI',
    description: page?.frontmatter.summary ?? 'Complete command reference for the vgpu CLI.',
  };
}

export default function CliPage() {
  const page = getDocsTopicPage('cli');
  if (!page) notFound();

  return (
    <DocsPageShell pathname="/cli" toc={extractToc(page.content)}>
      <MarkdownContent content={page.content} />
    </DocsPageShell>
  );
}
