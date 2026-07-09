import { Terminal } from "lucide-react";
import { highlightCode, countLinesInHtml } from "@/lib/shiki";
import { CopyButton } from "./CopyButton";

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  showLineNumbers?: boolean;
}

// Language display names and colors
const languageConfig: Record<string, { name: string; color: string }> = {
  typescript: { name: "TypeScript", color: "#3178c6" },
  ts: { name: "TypeScript", color: "#3178c6" },
  javascript: { name: "JavaScript", color: "#f7df1e" },
  js: { name: "JavaScript", color: "#f7df1e" },
  wgsl: { name: "WGSL", color: "#ff6b35" },
  bash: { name: "Bash", color: "#4eaa25" },
  shell: { name: "Shell", color: "#4eaa25" },
  json: { name: "JSON", color: "#292929" },
  html: { name: "HTML", color: "#e34c26" },
  css: { name: "CSS", color: "#1572b6" },
};

export async function CodeBlock({
  code,
  language = "typescript",
  filename,
  showLineNumbers = false,
}: CodeBlockProps) {
  const langConfig = languageConfig[language] || { name: language.toUpperCase(), color: "#888" };
  
  // Highlight code on the server at render time
  const highlightedHtml = await highlightCode(code, language);
  // Count actual line elements from Shiki's HTML output, not from raw code
  const lineCount = countLinesInHtml(highlightedHtml);

  return (
    <div className="group relative rounded-lg border border-[#333] bg-[#0a0a0a] overflow-hidden my-4">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#333] bg-[#111]">
        <div className="flex items-center gap-2">
          {filename ? (
            <span className="text-sm text-[#a1a1a1]">{filename}</span>
          ) : (
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[#666]" />
              <span className="text-sm text-[#a1a1a1]" style={{ color: langConfig.color }}>
                {langConfig.name}
              </span>
            </div>
          )}
        </div>
        <CopyButton code={code} />
      </div>

      {/* Code content */}
      <div className="relative overflow-x-auto">
        {showLineNumbers ? (
          <div className="flex">
            {/* Line numbers */}
            <div className="flex-none py-4 pl-4 pr-3 text-right select-none border-r border-[#333] bg-[#0a0a0a]">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="text-sm leading-6 text-[#444] font-mono">
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Code */}
            <div className="flex-1 py-4 px-4 overflow-x-auto">
              <div 
                className="text-sm leading-6 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent [&_code]:!text-sm [&_code]:!leading-6 [&_code_span.line]:!leading-6"
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </div>
          </div>
        ) : (
          <div className="py-4 px-4 overflow-x-auto">
            <div 
              className="text-sm leading-6 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
