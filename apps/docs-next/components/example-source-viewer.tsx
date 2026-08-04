import { ExampleSourceViewerTabs } from "@/components/example-source-viewer-tabs";
import { highlightCode } from "@/lib/shiki";

// TGEIST-09c: replaces the geistdocs `CodeBlock`-based viewer (TGEIST-09).
// That version passed raw source as plain `<code>` children, which
// `CodeBlock` does not syntax-highlight on its own (it expects pre-rendered
// MDX/rehype-pretty-code output) -- so examples with many files (e.g.
// triangle-led-front) rendered as a giant wrapping button grid on top of
// unhighlighted black-on-white text. This is a from-scratch replacement
// modeled on the old app's `apps/docs/components/code-viewer.tsx` (real
// shiki highlighting server-side, a compact single-row scrollable file
// tab bar, a copy button, a height-capped scrollable code pane), restyled
// with the ported `gray-*` tokens (`app/styles/legacy-vgpu-tokens.css`)
// instead of hardcoded hex so it still lines up with the rest of the
// migrated chrome.
//
// Highlighting runs here (server component) for every file up front --
// `/examples/[slug]` is fully static (`generateStaticParams`), so this is
// a one-time build-time cost, not a per-request one. The result is handed
// to a small client component that only toggles which pre-highlighted
// file is visible (see `example-source-viewer-tabs.tsx`).
export interface SourceFile {
  readonly name: string;
  readonly lang: string;
  readonly code: string;
}

interface ExampleSourceViewerProps {
  files: readonly SourceFile[];
}

function languageFor(file: SourceFile) {
  if (file.lang) {
    return file.lang;
  }
  if (file.name.endsWith(".wgsl")) {
    return "wgsl";
  }
  if (file.name.endsWith(".tsx")) {
    return "tsx";
  }
  if (file.name.endsWith(".ts")) {
    return "typescript";
  }
  if (file.name.endsWith(".json")) {
    return "json";
  }
  return "typescript";
}

export async function ExampleSourceViewer({ files }: ExampleSourceViewerProps) {
  if (files.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gray-4 p-4 text-copy-14 text-gray-900">
        No source files available.
      </p>
    );
  }

  const highlighted = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      code: file.code,
      html: await highlightCode(file.code, languageFor(file)),
    })),
  );

  return <ExampleSourceViewerTabs files={highlighted} />;
}
