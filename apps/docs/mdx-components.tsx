import type { MDXComponents } from 'mdx/types';
import { CodeBlock, Pre } from '@/components/mdx/CodeBlock';
import { Callout } from '@/components/mdx/Callout';
import { ApiTable, ApiSignature } from '@/components/mdx/ApiTable';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    // Default components with Vercel-inspired styling
    h1: ({ children }) => (
      <h1 className="text-4xl font-bold text-white mb-6 mt-8 first:mt-0 tracking-tight">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-2xl font-semibold text-white mb-4 mt-12 pb-2 border-b border-neutral-800 tracking-tight">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-xl font-semibold text-white mb-3 mt-8 tracking-tight">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-lg font-semibold text-white mb-2 mt-6 tracking-tight">{children}</h4>
    ),
    p: ({ children }) => (
      <p className="text-neutral-300 leading-7 mb-4">{children}</p>
    ),
    a: ({ href, children }) => (
      <a 
        href={href} 
        className="text-blue-400 hover:text-blue-300 underline underline-offset-4 decoration-blue-400/30 hover:decoration-blue-300/50 transition-colors"
      >
        {children}
      </a>
    ),
    ul: ({ children }) => (
      <ul className="list-disc text-neutral-300 mb-4 space-y-2 pl-6">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal text-neutral-300 mb-4 space-y-2 pl-6">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="leading-7 pl-1">{children}</li>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-neutral-700 pl-4 italic text-neutral-400 my-6">
        {children}
      </blockquote>
    ),
    code: ({ children, className }) => {
      // Check if it's a code block (handled by pre wrapper via rehype-pretty-code)
      const isCodeBlock = className?.includes('language-');
      
      if (isCodeBlock) {
        return <code className={className}>{children}</code>;
      }
      
      // Inline code styling
      return (
        <code className="bg-neutral-800/60 text-neutral-200 px-1.5 py-0.5 rounded text-[0.875em] font-mono border border-neutral-700/50">
          {children}
        </code>
      );
    },
    pre: Pre,
    table: ({ children }) => (
      <div className="overflow-x-auto my-6 rounded-lg border border-neutral-800">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-neutral-900/50">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-400 uppercase tracking-wider border-b border-neutral-800">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-3 text-neutral-300 border-b border-neutral-800">{children}</td>
    ),
    hr: () => <hr className="border-neutral-800 my-10" />,
    strong: ({ children }) => (
      <strong className="font-semibold text-white">{children}</strong>
    ),
    // Custom components
    Callout,
    CodeBlock,
    ApiTable,
    ApiSignature,
    ...components,
  };
}
