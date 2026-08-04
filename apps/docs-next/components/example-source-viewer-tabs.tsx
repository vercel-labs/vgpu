"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

// TGEIST-09c: client half of `ExampleSourceViewer` -- tab switching only,
// no re-highlighting on the client (shiki already ran server-side, see
// `example-source-viewer.tsx`). Markup/behavior ported from the old app's
// `apps/docs/components/code-viewer.tsx` (single-row scrollable file tabs +
// a scroll-capped code pane), swapping its `?file=` query-param/Link
// navigation for local `useState` since we pre-highlight every file up
// front instead of only the active one.
export interface HighlightedSourceFile {
  readonly name: string;
  readonly code: string;
  readonly html: string;
}

interface ExampleSourceViewerTabsProps {
  files: readonly HighlightedSourceFile[];
}

export function ExampleSourceViewerTabs({ files }: ExampleSourceViewerTabsProps) {
  const [activeName, setActiveName] = useState(files[0]?.name);
  const active = files.find((file) => file.name === activeName) ?? files[0];

  if (!active) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-4 bg-gray-1">
      <div className="flex items-center justify-between border-b border-gray-4 bg-gray-2">
        <div className="flex min-w-0 overflow-x-auto">
          {files.map((file) => {
            const isActive = file.name === active.name;
            return (
              <button
                className={cn(
                  "shrink-0 whitespace-nowrap border-r border-gray-4 px-4 py-2.5 font-mono text-xs transition-colors hover:text-gray-12",
                  isActive ? "bg-gray-1 text-gray-12" : "text-gray-9",
                )}
                key={file.name}
                onClick={() => setActiveName(file.name)}
                type="button"
              >
                {file.name}
              </button>
            );
          })}
        </div>
        <div className="shrink-0 px-2">
          <CopyButton code={active.code} />
        </div>
      </div>
      <div className="max-h-[70vh] overflow-auto p-4">
        <div
          className="text-sm leading-6 [&_code]:!bg-transparent [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
          dangerouslySetInnerHTML={{ __html: active.html }}
        />
      </div>
    </div>
  );
}
