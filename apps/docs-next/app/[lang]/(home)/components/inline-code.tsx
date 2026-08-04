import { Fragment } from 'react';

/** Strips the `backtick` markers, giving the plain text to put on the clipboard. */
export function stripBackticks(text: string): string {
  return text.replace(/`/g, '');
}

/**
 * Renders a string where `backtick`-wrapped spans are set in mono.
 *
 * For commands quoted mid-sentence ("install with `npx skills add vercel-labs/vgpu`"), where a
 * block would break the line but the text still has to read as literal — hence
 * a span swap. Geist Mono runs slightly wider and taller than Geist Sans at the
 * same px size, so code is nudged to 0.95em to keep the baseline row even.
 *
 * Fence only what is genuinely literal. Mono is a signal that the reader should
 * type the characters exactly; using it for a command merely *named* inside a
 * sentence mislabels prose as terminal input (see tabContent in hero-tabs).
 *
 * Ported verbatim (same behaviour + copy) from apps/docs/components/inline-code.tsx
 * — only the import path changed, since this landing owns its own copy of the
 * hero overlay components (see TGEIST-10).
 */
export function InlineCode({ text, mono = true }: { text: string; mono?: boolean }) {
  // Odd indices are the fenced spans: "a `b` c" -> ["a ", "b", " c"].
  return (
    <>
      {text.split('`').map((part, index) => {
        if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;

        // Fencing marks an ATOMIC run; `mono` decides whether it is also
        // *presented* as code. Those are separate concerns, and the Prompt tab
        // needs the first without the second.
        //
        // Unbreakable either way: a command split across lines ("run npx vgpu"
        // / "docs") reads as prose and strands an orphan word. Wrap before it.
        return mono ? (
          <code key={index} className="whitespace-nowrap font-mono text-[0.95em]">
            {part}
          </code>
        ) : (
          <span key={index} className="whitespace-nowrap">
            {part}
          </span>
        );
      })}
    </>
  );
}
