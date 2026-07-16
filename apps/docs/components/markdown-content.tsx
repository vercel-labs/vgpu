import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '@/components/code-block';
import { resolveMarkdownHref, resolveSymbolHref } from '@/lib/manifest';
import type { TocItem } from '@/components/table-of-contents';

interface HastNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Marks <code> elements that already live inside an <a> so the code renderer
// skips symbol autolinking (nested <a> breaks hydration). Runs on the hast
// tree because react-markdown hands hast nodes (with `properties`) to
// component renderers; mdast `data` never reaches them.
const markCodeInsideLinks = () => (tree: HastNode) => {
  const walk = (node: HastNode, inLink: boolean) => {
    if (node.tagName === 'code' && inLink) {
      node.properties = { ...node.properties, dataSkipAutolink: 'true' };
    }
    const childInLink = inLink || node.tagName === 'a';
    for (const child of node.children ?? []) walk(child, childInLink);
  };
  walk(tree, false);
};

interface MarkdownContentProps {
  content: string;
}

function textFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join('');
  return '';
}

function slugifyHeadingText(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function slugifyHeading(children: React.ReactNode) {
  return slugifyHeadingText(textFromChildren(children));
}

function normalizeCodeLanguage(language: string | undefined) {
  if (!language) return 'typescript';

  const normalized = language.toLowerCase();
  if (normalized === 'dockerfile' || normalized === 'sh' || normalized === 'shell') return 'bash';
  if (normalized === 'js') return 'javascript';
  if (normalized === 'txt' || normalized === 'text' || normalized === 'plain') return 'typescript';
  return normalized;
}

export function extractToc(content: string): TocItem[] {
  const headingCounts = new Map<string, number>();
  const items: TocItem[] = [];

  for (const match of content.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
    const level = match[1].length;
    const title = match[2]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
      .trim();
    const base = slugifyHeadingText(title);
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    if (level === 2 || level === 3) {
      items.push({
        id: count === 0 ? base : `${base}-${count + 1}`,
        title,
        level,
      });
    }
  }

  return items;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  const headingCounts = new Map<string, number>();
  const headingId = (children: React.ReactNode) => {
    const base = slugifyHeading(children);
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  return (
    <div className="prose-content text-gray-11 leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[markCodeInsideLinks]}
        components={{
          h1: ({ children }) => {
            const id = headingId(children);
            return (
              <h1 id={id} className="scroll-mt-24 text-3xl md:text-4xl font-semibold tracking-tight text-gray-12 mb-4">
                {children}
              </h1>
            );
          },
          h2: ({ children }) => {
            const id = headingId(children);
            return (
              <h2 id={id} className="group scroll-mt-24 text-2xl font-semibold tracking-tight text-gray-12 mt-10 mb-4">
                <a href={`#${id}`} className="no-underline text-gray-12">
                  {children}
                </a>
              </h2>
            );
          },
          h3: ({ children }) => {
            const id = headingId(children);
            return (
              <h3 id={id} className="group scroll-mt-24 text-xl font-semibold text-gray-12 mt-8 mb-3">
                <a href={`#${id}`} className="no-underline text-gray-12">
                  {children}
                </a>
              </h3>
            );
          },
          h4: ({ children }) => (
            <h4 className="text-base font-semibold text-gray-12 mt-6 mb-2">{children}</h4>
          ),
          p: ({ children }) => <p className="text-gray-11 my-4 leading-7">{children}</p>,
          a: ({ href, children }) => {
            const resolvedHref = resolveMarkdownHref(href);
            const isExternal = Boolean(resolvedHref?.startsWith('http'));
            if (!resolvedHref) return <span>{children}</span>;
            if (isExternal) {
              return (
                <a
                  href={resolvedHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-9 hover:text-blue-10 underline underline-offset-4"
                >
                  {children}
                </a>
              );
            }
            return (
              <Link href={resolvedHref} className="text-blue-9 hover:text-blue-10 underline underline-offset-4">
                {children}
              </Link>
            );
          },
          ul: ({ children }) => <ul className="my-4 ml-6 list-disc space-y-2 text-gray-11">{children}</ul>,
          ol: ({ children }) => <ol className="my-4 ml-6 list-decimal space-y-2 text-gray-11">{children}</ol>,
          li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-6 border-l-2 border-blue-9 bg-blue-1/40 px-4 py-2 text-gray-11">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-10 border-gray-4" />,
          table: ({ children }) => (
            <div className="my-6 overflow-x-auto rounded-lg border border-gray-4">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-2 text-gray-12">{children}</thead>,
          th: ({ children }) => <th className="border-b border-gray-4 px-4 py-2 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b border-gray-4 px-4 py-2 text-gray-11">{children}</td>,
          code: ({ className, children, node }) => {
            const skipAutoLink = Boolean((node as HastNode | undefined)?.properties?.dataSkipAutolink);
            const code = String(children).replace(/\n$/, '');
            const match = /language-([^\s]+)/.exec(className ?? '');
            if (!match && !code.includes('\n')) {
              const symbolHref = skipAutoLink ? undefined : resolveSymbolHref(code);
              if (symbolHref) {
                return (
                  <Link href={symbolHref} className="rounded bg-gray-2 px-1.5 py-0.5 text-sm text-blue-9 no-underline hover:text-blue-10">
                    <code>{children}</code>
                  </Link>
                );
              }
              return <code className="rounded bg-gray-2 px-1.5 py-0.5 text-sm text-gray-12">{children}</code>;
            }
            return <CodeBlock code={code} language={normalizeCodeLanguage(match?.[1])} showLineNumbers />;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
