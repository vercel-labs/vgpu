'use client';

import { useState, useRef, useEffect } from 'react';

interface CodeBlockProps {
  children: React.ReactNode;
  language?: string;
  title?: string;
  showLineNumbers?: boolean;
}

export function CodeBlock({ 
  children, 
  language = 'typescript', 
  title, 
  showLineNumbers = false 
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const copyToClipboard = async () => {
    if (preRef.current) {
      const code = preRef.current.textContent || '';
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative group my-4 rounded-lg overflow-hidden bg-[#0a0a0a] border border-neutral-800">
      {title && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#111] border-b border-neutral-800">
          <span className="text-sm text-neutral-400 font-mono">{title}</span>
          <span className="text-xs text-neutral-500 uppercase tracking-wider">{language}</span>
        </div>
      )}
      <div className="relative">
        <button
          onClick={copyToClipboard}
          className="absolute top-3 right-3 z-10 p-2 rounded-md bg-neutral-800/80 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 opacity-0 group-hover:opacity-100 transition-all duration-200"
          aria-label="Copy code"
        >
          {copied ? (
            <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
        <pre 
          ref={preRef}
          className={`p-4 overflow-x-auto text-sm leading-relaxed ${showLineNumbers ? 'line-numbers' : ''} ${!title ? 'rounded-lg' : ''}`}
          data-language={language}
        >
          {typeof children === 'string' ? (
            <code className={`language-${language}`}>{children}</code>
          ) : (
            children
          )}
        </pre>
      </div>
    </div>
  );
}

// Wrapper for pre tags that come from MDX/rehype-pretty-code
export function Pre({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const copyToClipboard = async () => {
    if (preRef.current) {
      const code = preRef.current.textContent || '';
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative group my-4">
      <button
        onClick={copyToClipboard}
        className="absolute top-3 right-3 z-10 p-2 rounded-md bg-neutral-800/80 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 opacity-0 group-hover:opacity-100 transition-all duration-200"
        aria-label="Copy code"
      >
        {copied ? (
          <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
      <pre 
        ref={preRef}
        {...props}
        className="rounded-lg border border-neutral-800 bg-[#0a0a0a] p-4 overflow-x-auto text-sm leading-relaxed"
      >
        {children}
      </pre>
    </div>
  );
}
