/**
 * Dependency-free mdast helpers shared by the `remark-geist` plugins (TGEIST-05).
 *
 * These plugins run inside `source.config.ts`, which is bundled by
 * `fumadocs-mdx` before Next.js ever starts, and they are also exercised by
 * plain `node --test` unit tests and by `scripts/check-mdast-parity.mjs`. To
 * keep all three entry points working without adding a single dependency to
 * `apps/docs-next/package.json` (no `unist-util-visit`, no
 * `mdast-util-to-string`), the ~40 lines of tree walking / text extraction we
 * need live here.
 *
 * Written as `.mjs` (JS + JSDoc) on purpose: the same file is imported by
 * `source.config.ts` (TypeScript infers the JSDoc types, `allowJs` is on) and
 * by `.mjs` scripts/tests that run on bare Node with no transpiler.
 *
 * @typedef {Object} MdastNode
 * @property {string} type
 * @property {string} [value]
 * @property {string} [alt]
 * @property {string} [url]
 * @property {string} [lang]
 * @property {string} [meta]
 * @property {string} [name]
 * @property {unknown[]} [attributes]
 * @property {Record<string, unknown>} [data]
 * @property {MdastNode[]} [children]
 */

/**
 * Depth-first walk over every node of an mdast tree, parents before children.
 *
 * @param {MdastNode} node
 * @param {(node: MdastNode, parent: MdastNode | null, index: number) => void} visitor
 * @param {MdastNode | null} [parent]
 * @param {number} [index]
 */
export function visit(node, visitor, parent = null, index = -1) {
  if (!node || typeof node !== "object") return;
  visitor(node, parent, index);
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    visit(children[i], visitor, node, i);
  }
}

/**
 * Depth-first walk that visits children before their parent. Used by the
 * blockquote → Callout mapping so a nested blockquote is rewritten before the
 * outer one is replaced (the outer replacement reuses the already-rewritten
 * children array).
 *
 * @param {MdastNode} node
 * @param {(node: MdastNode) => void} visitor
 */
export function visitPostOrder(node, visitor) {
  if (!node || typeof node !== "object") return;
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) visitPostOrder(child, visitor);
  }
  visitor(node);
}

/**
 * All the visible text of an mdast subtree, in document order.
 *
 * Mirrors `mdast-util-to-string`'s contract (`value ?? alt`, children
 * concatenated, nothing else) so the parity gate (Decision 4c) compares the
 * same thing a reader sees: text, inline code and fenced code bodies. Node
 * *types* and *attributes* — exactly what M1–M9 change — are invisible here,
 * which is what makes `toString(before) === toString(after)` an exact
 * invariant rather than an approximation.
 *
 * @param {MdastNode} node
 * @returns {string}
 */
export function mdastToText(node) {
  if (!node || typeof node !== "object") return "";
  const own =
    typeof node.value === "string" ? node.value : typeof node.alt === "string" ? node.alt : "";
  if (!Array.isArray(node.children)) return own;
  let out = own;
  for (const child of node.children) out += mdastToText(child);
  return out;
}

/**
 * Collapses every whitespace run to a single space and trims. The gate is
 * "equal modulo whitespace" because block-level rewrites can legitimately
 * change how text is chunked across nodes, never which characters exist.
 *
 * @param {string} text
 */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Flattened text of a node, used for prefix detection (M1/M2). Kept separate
 * from `mdastToText` so its intent is documented at the call site: this one is
 * a *predicate* input, not a parity input.
 *
 * @param {MdastNode} node
 */
export function flattenNode(node) {
  return mdastToText(node);
}

/**
 * Builds an `mdxJsxFlowElement` node — the same shape `fumadocs-core`'s own
 * `remarkAdmonition` produces (see `node_modules/fumadocs-core/dist/chunk-*.js`),
 * which is what makes it render as the mapped MDX component even in `.md`
 * files: `@mdx-js/mdx` adds every MDX JSX node type to `remark-rehype`'s
 * `passThrough` list unconditionally, not only for `format: "mdx"`
 * (`@mdx-js/mdx/lib/core.js:211`).
 *
 * @param {string} name
 * @param {Record<string, string>} attributes
 * @param {MdastNode[]} children
 * @returns {MdastNode}
 */
export function mdxJsxFlowElement(name, attributes, children) {
  return {
    type: "mdxJsxFlowElement",
    name,
    attributes: Object.entries(attributes).map(([attrName, value]) => ({
      type: "mdxJsxAttribute",
      name: attrName,
      value,
    })),
    children,
  };
}
