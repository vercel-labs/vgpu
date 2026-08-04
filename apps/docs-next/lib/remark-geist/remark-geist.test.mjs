/**
 * Unit tests for the M1–M9 remark plugins (TGEIST-05).
 *
 * Run with `pnpm --filter docs-next test:remark` (plain `node --test`, no test
 * runner dependency: `apps/docs-next` must not grow devDependencies during the
 * dual-run window, and the root vitest config does not include `apps/docs-next`
 * yet — TGEIST-06 is the ticket that extends it).
 *
 * Every input is a real line of the vgpu corpus (path + line noted), parsed by
 * the same `remark-parse` + `remark-gfm` the MDX pipeline uses, so the trap
 * cases are genuinely trap cases and not hand-built mdast that begs the
 * question.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calloutTypeFor, remarkCalloutBlockquotes } from "./callout-blockquotes.mjs";
import {
  buildDocLinkIndex,
  docsHref,
  isMarkdownDocHref,
  resolveMarkdownHref,
} from "./doc-link-index.mjs";
import { applyTransformers, loadMarkdownParser } from "./markdown-toolchain.mjs";
import { mdastToText, normalizeWhitespace, visit } from "./mdast-utils.mjs";
import { SHIKI_SPECIAL_LANGUAGES, remarkNormalizeCodeLang } from "./normalize-code-lang.mjs";
import { needsDocsPrefix, remarkResolveDocLinks } from "./resolve-doc-links.mjs";

const { parse } = await loadMarkdownParser();

/**
 * A hand-written slice of the real docs manifest: the exact records the fixture
 * links point at, with the fields `resolveMarkdownHref` reads. Keeping it
 * literal makes the expected URLs readable in the assertions instead of being
 * derived from the same code under test.
 */
const RECORDS = [
  {
    package: "guides",
    symbol: "getting-started",
    kind: "guide",
    virtualPath: "/guides/getting-started.docs.md",
    topic: "getting-started",
    anchor: "getting-started",
  },
  {
    package: "guides",
    symbol: "no-bundler",
    kind: "guide",
    virtualPath: "/guides/no-bundler.docs.md",
    topic: "no-bundler",
    anchor: "no-bundler",
  },
  {
    package: "guides",
    symbol: "concepts-frames",
    kind: "guide",
    virtualPath: "/guides/concepts-frames.docs.md",
    topic: "concepts-frames",
    anchor: "concepts-frames",
  },
  {
    package: "guides",
    symbol: "cli",
    kind: "guide",
    virtualPath: "/guides/cli.docs.md",
    websitePath: "/cli",
    topic: "cli",
    anchor: "cli",
  },
  {
    package: "@vgpu/wgsl",
    symbol: "resolveShader",
    kind: "api",
    virtualPath: "/@vgpu/wgsl/runtime/resolve-shader.docs.md",
    topic: "resolve-shader",
    anchor: "resolveshader",
  },
  {
    package: "vgpu",
    symbol: "frame",
    kind: "api",
    virtualPath: "/vgpu/frame.docs.md",
    topic: "frame",
    anchor: "frame",
  },
];

const index = buildDocLinkIndex(RECORDS);

/** Parses `markdown`, runs the plugin chain, returns the tree. */
async function transform(markdown, transformers, file = { path: "fixture.md" }) {
  const tree = parse(markdown);
  await applyTransformers(tree, transformers, file);
  return tree;
}

/** Collects every node of `type` in document order. */
function collect(tree, type) {
  const out = [];
  visit(tree, (node) => {
    if (node.type === type) out.push(node);
  });
  return out;
}

const codeLangPlugin = remarkNormalizeCodeLang({
  // The real chain passes Shiki's `bundledLanguages` keys; a literal subset
  // keeps the test hermetic and fast.
  knownLanguages: ["ts", "tsx", "js", "bash", "json", "wgsl", "glsl"],
});

const linkPlugin = remarkResolveDocLinks({ index });

describe("M1/M2/M3 — blockquote → Callout", () => {
  it("maps `Good to know:` to <Callout type=\"info\"> keeping the literal prefix", async () => {
    // docs/topics/concepts-passes.docs.md:119
    const source =
      "> Good to know: `frame.pass()` always needs a target. Use a canvas-backed [`Surface`](/reference/vgpu/surface#surface) from `surface(gpu, canvas)`.\n";
    const tree = await transform(source, [remarkCalloutBlockquotes()]);

    assert.equal(tree.children.length, 1);
    const callout = tree.children[0];
    assert.equal(callout.type, "mdxJsxFlowElement");
    assert.equal(callout.name, "Callout");
    assert.deepEqual(callout.attributes, [
      { type: "mdxJsxAttribute", name: "type", value: "info" },
    ]);
    // The prefix is NOT extracted: the Callout body still starts with it.
    assert.match(mdastToText(callout), /^Good to know: frame\.pass\(\) always needs a target/u);
    // And no text was lost or added.
    assert.equal(normalizeWhitespace(mdastToText(tree)), normalizeWhitespace(mdastToText(parse(source))));
  });

  it("maps `Warning:` to <Callout type=\"warn\">", async () => {
    // docs/topics/concepts-frames.docs.md:65
    const source =
      "> Warning: one-shot `draw()` calls do not join a surrounding frame — inside a frame callback they submit on their own immediately.\n";
    const tree = await transform(source, [remarkCalloutBlockquotes()]);
    const callout = tree.children[0];
    assert.equal(callout.name, "Callout");
    assert.deepEqual(callout.attributes, [
      { type: "mdxJsxAttribute", name: "type", value: "warn" },
    ]);
    assert.match(mdastToText(callout), /^Warning: one-shot draw\(\) calls/u);
  });

  it("uses only Callout types fumadocs-ui declares", async () => {
    // fumadocs-ui/dist/components/callout.d.ts: 'info' | 'warn' | 'error' | 'success' | 'warning' | 'idea'
    const declared = new Set(["info", "warn", "error", "success", "warning", "idea"]);
    const tree = await transform("> Good to know: a\n\n> Warning: b\n", [remarkCalloutBlockquotes()]);
    for (const node of collect(tree, "mdxJsxFlowElement")) {
      const type = node.attributes.find((attribute) => attribute.name === "type")?.value;
      assert.ok(declared.has(type), `unexpected Callout type ${type}`);
    }
  });

  it("M3: leaves a blockquote with no recognized prefix alone", async () => {
    // packages/wgsl-std/src/noise/index.docs.md:7-11 (the only such blockquote)
    const source =
      "> **Want fBM, turbulence, ridged noise, or domain warping?** Those are\n> compositions, not primitives: they live in the noise guide. Read it with\n> `npx vgpu docs cat /@vgpu/wgsl-std/noise/perlin/index.docs.md`.\n";
    const tree = await transform(source, [remarkCalloutBlockquotes()]);
    assert.equal(tree.children[0].type, "blockquote");
    assert.equal(collect(tree, "mdxJsxFlowElement").length, 0);
  });

  it("does not match a prefix that appears mid-paragraph", async () => {
    const tree = await transform(
      "> This paragraph mentions Good to know: in the middle, which is not an admonition.\n",
      [remarkCalloutBlockquotes()],
    );
    assert.equal(tree.children[0].type, "blockquote");
  });

  it("matches a bold prefix (flattened text still starts with it)", async () => {
    const tree = await transform("> **Warning:** bold prefix still maps.\n", [
      remarkCalloutBlockquotes(),
    ]);
    assert.equal(tree.children[0].name, "Callout");
  });

  it("rewrites a nested blockquote before the outer one", async () => {
    const source =
      "> Good to know: outer.\n>\n> > Warning: inner.\n";
    const tree = await transform(source, [remarkCalloutBlockquotes()]);
    const outer = tree.children[0];
    assert.equal(outer.name, "Callout");
    assert.equal(outer.attributes[0].value, "info");
    const inner = outer.children.at(-1);
    assert.equal(inner.name, "Callout");
    assert.equal(inner.attributes[0].value, "warn");
  });
});

describe("M4/M5/M6 — fenced code languages", () => {
  it("M4: normalizes ```terminal to bash (Shiki has no `terminal` grammar)", async () => {
    // docs/topics/cli.docs.md — 19 occurrences of this fence in the corpus.
    const source = "```terminal\nnpx vgpu doctor\n```\n";
    const tree = await transform(source, [codeLangPlugin]);
    const [code] = collect(tree, "code");
    assert.equal(code.lang, "bash");
    assert.equal(code.data.geistOriginalLang, "terminal");
    // No fence meta for an alias: a bare `terminal` label is not information a
    // reader needs, and meta can surface as a code-block title.
    assert.equal(code.meta ?? null, null);
    assert.equal(code.value, "npx vgpu doctor");
  });

  it("M5: normalizes sh → bash and typescript → ts", async () => {
    const tree = await transform("```sh\npnpm add vgpu\n```\n\n```typescript\nconst a = 1;\n```\n", [
      codeLangPlugin,
    ]);
    const [sh, ts] = collect(tree, "code");
    assert.equal(sh.lang, "bash");
    assert.equal(ts.lang, "ts");
  });

  it("M6: leaves ts / wgsl / json untouched", async () => {
    const tree = await transform(
      "```ts\nconst a = 1;\n```\n\n```wgsl\nfn main() {}\n```\n\n```json\n{}\n```\n",
      [codeLangPlugin],
    );
    assert.deepEqual(
      collect(tree, "code").map((node) => node.lang),
      ["ts", "wgsl", "json"],
    );
  });

  it("canonicalizes a label that differs from Shiki's only in case", async () => {
    // Shiki's lookup is case-sensitive: `codeToHtml` with `JSON`, `Ts` or `WGSL`
    // throws `Language ... is not included in this bundle` and fails `next build`
    // exactly like `terminal` does. Since the alias table and the known-language
    // set are both keyed on lowercase, an uppercase label used to slip through
    // untouched — passing the gate and breaking the build.
    const tree = await transform(
      "```JSON\n{}\n```\n\n```Ts\nconst a = 1;\n```\n\n```WGSL\nfn main() {}\n```\n",
      [codeLangPlugin],
    );
    const codes = collect(tree, "code");
    assert.deepEqual(
      codes.map((node) => node.lang),
      ["json", "ts", "wgsl"],
    );
    // A canonical-spelling rewrite is not a degradation: no fence meta is added,
    // and the block still gets highlighted.
    assert.deepEqual(
      codes.map((node) => node.meta ?? null),
      [null, null, null],
    );
    assert.deepEqual(
      codes.map((node) => node.data?.geistLangAction),
      ["case", "case", "case"],
    );
  });

  it("classifies each normalization so the gate can list degradations apart", async () => {
    const tree = await transform(
      "```terminal\nnpx vgpu doctor\n```\n\n```JSON\n{}\n```\n\n```somethingnew\nx\n```\n",
      [codeLangPlugin],
    );
    assert.deepEqual(
      collect(tree, "code").map((node) => node.data?.geistLangAction),
      ["alias", "case", "degraded"],
    );
  });

  it("leaves a fence with no info string unhighlighted (744 in the corpus)", async () => {
    const tree = await transform("```\nVGPU-WGSL-ENTRY-NOT-FOUND\n```\n", [codeLangPlugin]);
    const [code] = collect(tree, "code");
    assert.equal(code.lang, null);
    assert.equal(code.meta ?? null, null);
  });

  it("degrades an unknown-but-identifier label to text (belt and braces for M4)", async () => {
    const tree = await transform("```somethingnew\nx\n```\n", [codeLangPlugin]);
    const [code] = collect(tree, "code");
    assert.equal(code.lang, "text");
    assert.equal(code.meta, "somethingnew");
  });

  it("degrades a non-identifier label to text, preserving it as meta (eve's case)", async () => {
    const tree = await transform("```384:401:packages/wgsl/src/x.ts\nconst a = 1;\n```\n", [
      codeLangPlugin,
    ]);
    const [code] = collect(tree, "code");
    assert.equal(code.lang, "text");
    assert.equal(code.meta, "384:401:packages/wgsl/src/x.ts");
  });
});

describe("M7 — relative *.docs.md links", () => {
  it("resolves a guide link to its /docs page", async () => {
    // docs/topics/no-bundler.docs.md:13
    const tree = await transform("[Getting started](getting-started.docs.md)\n", [linkPlugin]);
    const [link] = collect(tree, "link");
    assert.equal(link.url, "/docs/guides/getting-started");
  });

  it("resolves a virtual-absolute API link, keeping the record anchor", async () => {
    // docs/topics/no-bundler.docs.md:53
    const tree = await transform(
      "[`resolveShader` reference](/@vgpu/wgsl/runtime/resolve-shader.docs.md)\n",
      [linkPlugin],
    );
    const [link] = collect(tree, "link");
    assert.equal(link.url, "/docs/reference/wgsl/resolve-shader#resolveshader");
  });

  it("keeps an explicit hash from the source href", async () => {
    // packages/wgsl/src/runtime/resolve-shader.docs.md:148 shape
    const tree = await transform("[No bundler](/guides/no-bundler.docs.md#vite)\n", [linkPlugin]);
    const [link] = collect(tree, "link");
    assert.equal(link.url, "/docs/guides/no-bundler#vite");
  });

  it("prefers websitePath when the record has one", () => {
    assert.equal(resolveMarkdownHref("cli.docs.md", index), "/cli");
    const legacy = buildDocLinkIndex(RECORDS, { preferWebsitePath: false });
    assert.equal(resolveMarkdownHref("cli.docs.md", legacy), "/guides/cli");
  });

  it("resolves reference-style link definitions too", async () => {
    const tree = await transform(
      "See the [workflow][w].\n\n[w]: /guides/no-bundler.docs.md\n",
      [linkPlugin],
    );
    const [definition] = collect(tree, "definition");
    assert.equal(definition.url, "/docs/guides/no-bundler");
  });

  it("THE TRAP: rewrites the link but never the identical string inside a code-span", async () => {
    // docs/topics/no-bundler.docs.md:53 verbatim — a real link followed by the
    // same path inside inline code, on one line. A regex would rewrite both.
    const source =
      "Full parameters, the return shape, and every `VGPU-WGSL-*` error code live in the [`resolveShader` reference](/@vgpu/wgsl/runtime/resolve-shader.docs.md) (`npx vgpu docs cat /@vgpu/wgsl/runtime/resolve-shader.docs.md`).\n";
    const tree = await transform(source, [linkPlugin]);

    const [link] = collect(tree, "link");
    assert.equal(link.url, "/docs/reference/wgsl/resolve-shader#resolveshader");

    const inlineCodes = collect(tree, "inlineCode").map((node) => node.value);
    assert.ok(
      inlineCodes.includes("npx vgpu docs cat /@vgpu/wgsl/runtime/resolve-shader.docs.md"),
      `code-span was mutated: ${JSON.stringify(inlineCodes)}`,
    );
    // Nothing in the rendered text changed at all.
    assert.equal(
      normalizeWhitespace(mdastToText(tree)),
      normalizeWhitespace(mdastToText(parse(source))),
    );
  });

  it("never touches a *.docs.md path inside a fenced code block", async () => {
    const source =
      "```text\nSee [frames](concepts-frames.docs.md) and /reference/vgpu/frame#framepass\n```\n";
    const tree = await transform(source, [codeLangPlugin, linkPlugin]);
    const [code] = collect(tree, "code");
    assert.equal(
      code.value,
      "See [frames](concepts-frames.docs.md) and /reference/vgpu/frame#framepass",
    );
    assert.equal(collect(tree, "link").length, 0);
  });

  it("throws by default when a *.docs.md link has no record (85-broken-links risk)", async () => {
    await assert.rejects(
      () => transform("[gone](this-page-does-not-exist.docs.md)\n", [linkPlugin]),
      /could not be resolved/u,
    );
  });

  it("reports instead of throwing when configured to warn", async () => {
    const reports = [];
    const lenient = remarkResolveDocLinks({
      index,
      onUnresolvedMarkdownLink: "silent",
      onReport: (report) => reports.push(report),
    });
    const tree = await transform("[gone](this-page-does-not-exist.docs.md)\n", [lenient]);
    assert.equal(collect(tree, "link")[0].url, "this-page-does-not-exist.docs.md");
    assert.deepEqual(reports.map((report) => report.reason), ["unresolved-docs-md"]);
  });
});

describe("M8 — absolute logical links", () => {
  it("prefixes /docs onto logical docs paths, anchor included", async () => {
    // docs/topics/concepts-passes.docs.md:61
    const tree = await transform(
      "- [`FramePass.draw()`](/reference/vgpu/frame#framepass)\n- [Concepts: draws](/concepts/draws)\n- [Quickstart: Browser](/ml/browser)\n",
      [linkPlugin],
    );
    assert.deepEqual(
      collect(tree, "link").map((node) => node.url),
      ["/docs/reference/vgpu/frame#framepass", "/docs/concepts/draws", "/docs/ml/browser"],
    );
  });

  it("respects docsHref's /examples exception (whole subtree)", async () => {
    const tree = await transform(
      "- [gallery](/examples)\n- [one example](/examples/air-painting)\n- [not the subtree](/examples-archive/old)\n",
      [linkPlugin],
    );
    assert.deepEqual(
      collect(tree, "link").map((node) => node.url),
      ["/examples", "/examples/air-painting", "/docs/examples-archive/old"],
    );
  });

  it("is idempotent: an already-prefixed /docs link is left alone", async () => {
    const tree = await transform("[x](/docs/reference/vgpu/frame#framepass)\n", [linkPlugin]);
    assert.equal(collect(tree, "link")[0].url, "/docs/reference/vgpu/frame#framepass");
  });

  it("leaves API routes, protocol-relative and external hrefs untouched", async () => {
    const tree = await transform(
      "- [api](/api/examples/v1/latest.json)\n- [pr](//example.com/x)\n- [spec](https://www.w3.org/TR/webgpu/)\n- [mail](mailto:docs@example.com)\n",
      [linkPlugin],
    );
    assert.deepEqual(
      collect(tree, "link").map((node) => node.url),
      [
        "/api/examples/v1/latest.json",
        "//example.com/x",
        "https://www.w3.org/TR/webgpu/",
        "mailto:docs@example.com",
      ],
    );
  });

  it("leaves an external link that happens to end in .docs.md alone", async () => {
    // The ported `resolveMarkdownHref` opens with `/^(https?:|mailto:|#)/` and
    // returns such hrefs untouched, so a link to someone else's repo file is a
    // fine external link. Testing the `*.docs.md` branch first made this fail the
    // build as an "unresolved *.docs.md link" — a divergence from the original
    // with a message that sends the reader looking for a missing manifest record.
    const tree = await transform(
      "- [upstream](https://github.com/vercel-labs/vgpu/blob/main/docs/topics/cli.docs.md)\n" +
        "- [anchor](#framepass)\n",
      [linkPlugin],
    );
    assert.deepEqual(
      collect(tree, "link").map((node) => node.url),
      ["https://github.com/vercel-labs/vgpu/blob/main/docs/topics/cli.docs.md", "#framepass"],
    );
  });

  it("docsHref matches the ported original exactly", () => {
    assert.equal(docsHref("/reference/vgpu/frame#framepass"), "/docs/reference/vgpu/frame#framepass");
    assert.equal(docsHref("/examples/air-painting"), "/examples/air-painting");
  });
});

describe("M9/M10 — no-ops that must stay no-ops", () => {
  it("M9: anchor-only links are untouched (prod redirects depend on them)", async () => {
    const tree = await transform(
      "- [`FramePass`](#framepass)\n- [`FramePassOptions`](#framepassoptions)\n",
      [linkPlugin],
    );
    assert.deepEqual(
      collect(tree, "link").map((node) => node.url),
      ["#framepass", "#framepassoptions"],
    );
  });

  it("M10: the empty link is reported, not rewritten", async () => {
    const reports = [];
    const plugin = remarkResolveDocLinks({ index, onReport: (report) => reports.push(report) });
    const tree = await transform("[broken]()\n", [plugin]);
    assert.equal(collect(tree, "link")[0].url, "");
    assert.deepEqual(reports.map((report) => report.reason), ["empty-link"]);
  });
});

describe("Decision 4c invariant — the chain never changes text", () => {
  it("holds for a page containing every mapping at once", async () => {
    const source = [
      "> Good to know: see [frames](concepts-frames.docs.md) and [`FramePass`](/reference/vgpu/frame#framepass).",
      "",
      "> Warning: `draw()` does not join a frame.",
      "",
      "> **Want fBM?** Read `npx vgpu docs cat /@vgpu/wgsl-std/noise/perlin/index.docs.md`.",
      "",
      "```terminal",
      "npx vgpu docs cat /guides/getting-started.docs.md",
      "```",
      "",
      "```wgsl",
      "fn main() {}",
      "```",
      "",
      "Anchor only: [x](#framepass). Empty: [y](). Example: [z](/examples/air-painting).",
      "",
    ].join("\n");

    const before = normalizeWhitespace(mdastToText(parse(source)));
    const tree = await transform(source, [codeLangPlugin, remarkCalloutBlockquotes(), linkPlugin]);
    const after = normalizeWhitespace(mdastToText(tree));
    assert.equal(after, before);
  });
});

describe("gate post-conditions — the predicates the parity gate asserts with", () => {
  // The gate's job is not only "text unchanged": it also has to notice when a
  // mapping stops happening at all. It asserts that with these two predicates, so
  // they are pinned here. The M8 half was missing originally, which meant M8 could
  // be deleted wholesale with the gate still green.
  it("needsDocsPrefix flags exactly the hrefs M8 must rewrite", () => {
    for (const href of ["/reference/vgpu/frame#framepass", "/ml/browser", "/concepts/passes"]) {
      assert.equal(needsDocsPrefix(href), true, `${href} should need the /docs prefix`);
    }
    for (const href of [
      "/docs/reference/vgpu/frame", // already prefixed
      "/examples", // top-level route
      "/examples/air-painting",
      "/api/examples/v1/latest.json",
      "//example.com/x", // protocol-relative
      "#framepass", // M9
      "concepts-frames.docs.md", // relative, M7's job
    ]) {
      assert.equal(needsDocsPrefix(href), false, `${href} should NOT be prefixed`);
    }
  });

  it("after the chain, no link satisfies either failure predicate", async () => {
    const source = [
      "- [frames](concepts-frames.docs.md)",
      "- [`FramePass`](/reference/vgpu/frame#framepass)",
      "- [ml](/ml/browser)",
      "- [gallery](/examples/air-painting)",
      "- [anchor](#framepass)",
    ].join("\n");
    const tree = await transform(source, [linkPlugin]);
    for (const node of collect(tree, "link")) {
      assert.equal(isMarkdownDocHref(node.url), false, `${node.url} still points at a .docs.md`);
      assert.equal(needsDocsPrefix(node.url), false, `${node.url} still lacks the /docs prefix`);
    }
  });

  it("both predicates catch a survivor when the mapping is skipped", async () => {
    // Simulates the mutation the reviewer used: chain without the link plugin.
    const tree = await transform(
      "- [frames](concepts-frames.docs.md)\n- [`FramePass`](/reference/vgpu/frame#framepass)\n",
      [],
    );
    const urls = collect(tree, "link").map((node) => node.url);
    assert.equal(urls.filter((url) => isMarkdownDocHref(url)).length, 1);
    assert.equal(urls.filter((url) => needsDocsPrefix(url)).length, 1);
  });

  it("calloutTypeFor flags a blockquote M1/M2 should have converted", async () => {
    // Text parity is blind to this mapping disappearing: a Callout and a
    // blockquote hold the same words. So the gate asserts on the matcher instead.
    const source = "> Good to know: frames are cheap.\n\n> Warning: not reentrant.\n\n> Plain note.\n";

    const untouched = collect(await transform(source, []), "blockquote");
    assert.deepEqual(
      untouched.map((node) => calloutTypeFor(node)),
      ["info", "warn", null],
      "without the plugin, two blockquotes still match — the gate must catch this",
    );

    const converted = collect(await transform(source, [remarkCalloutBlockquotes()]), "blockquote");
    assert.deepEqual(
      converted.map((node) => calloutTypeFor(node)),
      [null],
      "after the plugin only the M3 blockquote survives, and it matches nothing",
    );
  });

  it("the Shiki oracle is case-sensitive, like Shiki itself", () => {
    // `bundledLanguages` keys are all lowercase, so an oracle that lowercases the
    // node's language before looking it up is strictly weaker than Shiki and lets
    // ` ```JSON ` through. The gate must query the label as the node carries it.
    const shikiLanguages = new Set(["json", "ts", "wgsl", ...SHIKI_SPECIAL_LANGUAGES]);
    assert.equal(shikiLanguages.has("JSON"), false);
    assert.equal(shikiLanguages.has("json"), true);
  });
});
