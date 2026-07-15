import Link from 'next/link';
import { highlightCode } from '@/lib/shiki';
import { CopyButton } from './copy-button';

export interface CodeViewerFile {
  name: string;
  lang?: string;
  language?: string;
  code: string;
}

interface CodeViewerProps {
  files: readonly CodeViewerFile[];
  activeFile?: string;
}

function languageFor(file: CodeViewerFile) {
  if (file.lang) return file.lang;
  if (file.language) return file.language;
  if (file.name.endsWith('.wgsl')) return 'wgsl';
  if (file.name.endsWith('.tsx')) return 'tsx';
  if (file.name.endsWith('.ts')) return 'typescript';
  if (file.name.endsWith('.json')) return 'json';
  return 'typescript';
}

export async function CodeViewer({ files, activeFile }: CodeViewerProps) {
  const selected = files.find((file) => file.name === activeFile) ?? files[0];

  if (!selected) {
    return (
      <div className="rounded-lg border border-gray-4 bg-gray-1 p-4 text-sm text-gray-9">
        No source files available.
      </div>
    );
  }

  const highlightedHtml = await highlightCode(selected.code, languageFor(selected));

  return (
    <div className="rounded-lg border border-gray-4 bg-[#0a0a0a] overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-4 bg-[#111]">
        <div className="flex min-w-0 overflow-x-auto">
          {files.map((file) => {
            const isActive = file.name === selected.name;
            return (
              <Link
                key={file.name}
                href={`?file=${encodeURIComponent(file.name)}`}
                scroll={false}
                className={`px-4 py-2.5 text-sm border-r border-gray-4 whitespace-nowrap transition-colors hover:text-gray-12 ${
                  isActive ? 'bg-[#0a0a0a] text-gray-12' : 'text-gray-9'
                }`}
              >
                {file.name}
              </Link>
            );
          })}
        </div>
        <div className="px-2 shrink-0">
          <CopyButton code={selected.code} />
        </div>
      </div>
      <div className="max-h-[70vh] overflow-auto p-4">
        <div
          className="text-sm leading-6 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </div>
    </div>
  );
}
