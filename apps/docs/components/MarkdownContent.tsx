import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '@/components/CodeBlock';
import { resolveMarkdownHref } from '@/lib/manifest';

interface MarkdownContentProps {
  content: string;
}

function textFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join('');
  return '';
}

function slugifyHeading(children: React.ReactNode) {
  return textFromChildren(children)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function normalizeCodeLanguage(language: string | undefined) {
  if (!language) return 'typescript';

  const normalized = language.toLowerCase();
  if (normalized === 'dockerfile' || normalized === 'sh' || normalized === 'shell') return 'bash';
  if (normalized === 'js') return 'javascript';
  if (normalized === 'txt' || normalized === 'text' || normalized === 'plain') return 'typescript';
  return normalized;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="prose-content text-gray-11 leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-gray-12 mb-4">
              {children}
            </h1>
          ),
          h2: ({ children }) => {
            const id = slugifyHeading(children);
            return (
              <h2 id={id} className="group scroll-mt-24 text-2xl font-semibold tracking-tight text-gray-12 mt-10 mb-4">
                <a href={`#${id}`} className="no-underline text-gray-12">
                  {children}
                </a>
              </h2>
            );
          },
          h3: ({ children }) => {
            const id = slugifyHeading(children);
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
          code: ({ className, children }) => {
            const code = String(children).replace(/\n$/, '');
            const match = /language-([^\s]+)/.exec(className ?? '');
            if (!match && !code.includes('\n')) {
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
