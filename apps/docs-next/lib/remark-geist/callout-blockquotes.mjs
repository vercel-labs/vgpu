/**
 * M1 / M2 / M3 of the mapping inventory (Decision 2.4): blockquotes → Callout.
 *
 *  - M1: a blockquote whose text starts with `Good to know:` (5×) becomes
 *        `<Callout type="info">`.
 *  - M2: a blockquote whose text starts with `Warning:` (2×) becomes
 *        `<Callout type="warn">`.
 *  - M3: every other blockquote (the single multi-line `> **Want fBM...**` one)
 *        is **left untouched** — fumadocs styles a plain blockquote fine, and
 *        picking a Callout type for it would be a judgement call, not a
 *        mechanical mapping.
 *
 * The prefix stays **inside** the Callout, verbatim: the children array of the
 * blockquote is moved over as-is, so the rendered text is byte-identical to the
 * source and the parity gate (Decision 4c) is plain string equality with no
 * normalizer. Extracting `Good to know:` into a `<CalloutTitle>` is the
 * explicitly deferred phase-2 opt-in.
 *
 * `type` values verified against the installed dependency, not assumed:
 * `node_modules/fumadocs-ui/dist/components/callout.d.ts` declares
 * `CalloutType = 'info' | 'warn' | 'error' | 'success' | 'warning' | 'idea'`,
 * and `@vercel/geistdocs/dist/mdx.js` re-exports `Callout` (its own wrapper of
 * that primitive) into the MDX component map used by
 * `components/geistdocs/mdx-components.tsx`, so `<Callout type="info">` and
 * `<Callout type="warn">` both resolve at render time.
 */

import { flattenNode, mdxJsxFlowElement, visitPostOrder } from "./mdast-utils.mjs";

/**
 * Literal prefixes, in match order. Case-sensitive on purpose: the corpus
 * writes exactly `Good to know:` / `Warning:`, and a lenient matcher would be
 * a silent behaviour change for future authors (a sentence starting with
 * "warning:" mid-flow is not an admonition).
 *
 * Matching runs on the blockquote's flattened text, so `> **Warning:** ...`
 * (bold prefix) matches too.
 *
 * @type {ReadonlyArray<{ prefix: string, calloutType: string }>}
 */
export const DEFAULT_CALLOUT_PREFIXES = Object.freeze([
  { prefix: "Good to know:", calloutType: "info" },
  { prefix: "Warning:", calloutType: "warn" },
]);

/**
 * @typedef {Object} CalloutBlockquotesOptions
 * @property {ReadonlyArray<{ prefix: string, calloutType: string }>} [prefixes]
 * @property {string} [componentName] Defaults to `Callout`.
 */

/**
 * The Callout type a blockquote maps to, or `null` for M3 (leave it alone).
 *
 * Exported because the parity gate asserts the M1/M2 post-condition with it:
 * after the chain, no blockquote may still match a recognized prefix. Sharing
 * the predicate is deliberate — text parity alone cannot notice that M1/M2 have
 * stopped happening (a Callout and a blockquote hold the same words), so
 * dropping the plugin used to leave the gate green with the Callouts gone from
 * the HTML.
 *
 * @param {import("./mdast-utils.mjs").MdastNode} blockquote
 * @param {ReadonlyArray<{ prefix: string, calloutType: string }>} [prefixes]
 */
export function calloutTypeFor(blockquote, prefixes = DEFAULT_CALLOUT_PREFIXES) {
  const text = flattenNode(blockquote).replace(/^\s+/u, "");
  for (const { prefix, calloutType } of prefixes) {
    if (text.startsWith(prefix)) return calloutType;
  }
  return null;
}

/**
 * remark plugin: rewrites recognized blockquotes into Callout components.
 *
 * @param {CalloutBlockquotesOptions} [options]
 */
export function remarkCalloutBlockquotes(options = {}) {
  const prefixes = options.prefixes ?? DEFAULT_CALLOUT_PREFIXES;
  const componentName = options.componentName ?? "Callout";

  return (/** @type {import("./mdast-utils.mjs").MdastNode} */ tree) => {
    // Post-order so a blockquote nested inside another blockquote is rewritten
    // before its parent is replaced; the parent then carries the already
    // rewritten children.
    visitPostOrder(tree, (node) => {
      if (!Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (!child || child.type !== "blockquote") continue;
        const calloutType = calloutTypeFor(child, prefixes);
        if (!calloutType) continue; // M3: leave it as a blockquote.
        node.children[i] = mdxJsxFlowElement(
          componentName,
          { type: calloutType },
          child.children ?? [],
        );
      }
    });
  };
}

export default remarkCalloutBlockquotes;
