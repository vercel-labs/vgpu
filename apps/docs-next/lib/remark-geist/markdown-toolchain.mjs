/**
 * Loads a bare `remark-parse` + `remark-gfm` markdown parser for the unit tests
 * and for `scripts/check-mdast-parity.mjs`.
 *
 * Why the indirection: `apps/docs-next` must not grow dependencies during the
 * dual-run window (its `package.json` is the pinned geistdocs 1.15.2 template
 * plus what the app itself imports), and the parity gate is *tooling*, not app
 * code. `remark-parse`, `remark-gfm`, `unified` and friends are already in the
 * store as transitive dependencies of the MDX pipeline the app compiles with —
 * `fumadocs-mdx` → `@mdx-js/mdx` → `remark-parse`. Resolving them *through*
 * `fumadocs-mdx`'s own location gives the exact same copies the build uses,
 * with no install, no lockfile churn and no lie about what is a dependency.
 *
 * If this ever fails to resolve, the fix is a real devDependency — not a
 * silent skip: the gate throws.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * @returns {Promise<{ parse: (markdown: string) => import("./mdast-utils.mjs").MdastNode }>}
 */
export async function loadMarkdownParser() {
  let anchor;
  try {
    anchor = import.meta.resolve("fumadocs-mdx/config");
  } catch (error) {
    throw new Error(
      "remark-geist tooling could not locate `fumadocs-mdx/config`, which is how it borrows the " +
        "markdown parser the MDX pipeline already uses. Run `pnpm install` in the repo root " +
        `first. (${String(error)})`,
    );
  }

  const requireFromPipeline = createRequire(anchor);
  const load = async (specifier) => {
    let resolved;
    try {
      resolved = requireFromPipeline.resolve(specifier);
    } catch (error) {
      throw new Error(
        `remark-geist tooling needs \`${specifier}\`, normally present as a transitive dependency ` +
          `of fumadocs-mdx/@mdx-js/mdx. It did not resolve (${String(error)}). Add it as a ` +
          "devDependency of apps/docs-next if the MDX pipeline stopped shipping it.",
      );
    }
    return import(pathToFileURL(resolved).href);
  };

  const [{ unified }, remarkParseModule, remarkGfmModule] = await Promise.all([
    load("unified"),
    load("remark-parse"),
    load("remark-gfm"),
  ]);

  // GFM is part of the real pipeline (fumadocs enables it), so the fixture
  // tables and autolinks parse the same way here as in `next build`.
  const processor = unified()
    .use(remarkParseModule.default ?? remarkParseModule)
    .use(remarkGfmModule.default ?? remarkGfmModule);

  return {
    parse(markdown) {
      return /** @type {import("./mdast-utils.mjs").MdastNode} */ (processor.parse(markdown));
    },
  };
}

/**
 * Applies a list of remark transformers (the plugin *instances* returned by
 * `geistRemarkPlugins`) to a tree, in order, awaiting async ones.
 *
 * @param {import("./mdast-utils.mjs").MdastNode} tree
 * @param {Array<(tree: any, file?: any) => unknown>} transformers
 * @param {{ path?: string }} [file]
 */
export async function applyTransformers(tree, transformers, file = {}) {
  for (const transform of transformers) {
    await transform(tree, file);
  }
  return tree;
}
