import { createHighlighter, type Highlighter } from 'shiki';

// Use a global cache to ensure true singleton across module reloads in dev
const globalForHighlighter = globalThis as unknown as {
  highlighterPromise?: Promise<Highlighter>;
};

export async function getHighlighter() {
  if (!globalForHighlighter.highlighterPromise) {
    globalForHighlighter.highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'javascript', 'tsx', 'jsx', 'json', 'bash', 'html', 'css', 'wgsl'],
    });
  }
  return globalForHighlighter.highlighterPromise;
}

export async function highlightCode(code: string, language: string): Promise<string> {
  const highlighter = await getHighlighter();
  const html = highlighter.codeToHtml(code.trim(), {
    lang: language,
    theme: 'github-dark',
  });
  
  // Fix empty lines that Shiki renders as empty spans with no content
  // Replace empty spans with spans containing a non-breaking space
  return html.replace(/<span class="line"><\/span>/g, '<span class="line">&nbsp;</span>');
}

export function countLinesInHtml(html: string): number {
  // Count the number of <span class="line"> elements in the HTML
  const matches = html.match(/<span class="line">/g);
  return matches ? matches.length : 0;
}
