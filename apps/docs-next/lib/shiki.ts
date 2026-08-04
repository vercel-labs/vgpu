import { createHighlighter, type Highlighter } from "shiki";

// TGEIST-09c: ported verbatim from `apps/docs/lib/shiki.ts` (the old app's
// code-viewer highlighter) -- singleton `shiki` highlighter cached on
// `globalThis` so dev-mode module reloads don't spin up a second WASM
// instance, `github-dark` theme, WGSL grammar included alongside the usual
// web languages so example shader source highlights correctly.
const globalForHighlighter = globalThis as unknown as {
  highlighterPromise?: Promise<Highlighter>;
};

export async function getHighlighter() {
  if (!globalForHighlighter.highlighterPromise) {
    globalForHighlighter.highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: ["typescript", "javascript", "tsx", "jsx", "json", "bash", "html", "css", "wgsl"],
    });
  }
  return globalForHighlighter.highlighterPromise;
}

export async function highlightCode(code: string, language: string): Promise<string> {
  const highlighter = await getHighlighter();
  const html = highlighter.codeToHtml(code.trim(), {
    lang: language,
    theme: "github-dark",
  });

  // Shiki renders blank source lines as an empty `<span class="line"></span>`
  // with no content, which collapses to zero height in some browsers.
  // Give it a non-breaking space so blank lines keep their line height.
  return html.replace(/<span class="line"><\/span>/g, '<span class="line">&nbsp;</span>');
}
