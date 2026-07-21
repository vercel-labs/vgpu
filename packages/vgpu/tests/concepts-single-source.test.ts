import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { CONCEPT_FILES, conceptSlugs, getConceptPage } from "../../../apps/docs/lib/concepts";

const root = resolve(import.meta.dirname, "../../..");
const slugs = ["context", "draws", "compilation", "effects", "passes", "frames", "render-bundles"];
const nav = [
  ["Context", "/concepts/context"],
  ["Draws", "/concepts/draws"],
  ["Compilation", "/concepts/compilation"],
  ["Effects", "/concepts/effects"],
  ["Passes", "/concepts/passes"],
  ["Frames", "/concepts/frames"],
  ["Render bundles", "/concepts/render-bundles"],
];
const metadata = {
  context: ["Context", "init() creates the Gpu context; every surface, target, effect, and frame is created from it.", "/get-started/node", "/concepts/draws"],
  draws: ["Draws", "gpu.draw() renders geometry with custom vertex buffers — you write the vertex stage, gpu.mesh() supplies the buffers.", "/concepts/context", "/concepts/compilation"],
  compilation: ["Compilation", "Pipelines compile lazily on first use; pre-warm them during load so the first frame doesn't hitch.", "/concepts/draws", "/concepts/effects"],
  effects: ["Effects", "An effect is a full-screen fragment shader; chain effects by binding a target as another effect's input.", "/concepts/compilation", "/concepts/passes"],
  passes: ["Passes", "A pass composites any number of draws into one target; a single shader can draw directly.", "/concepts/effects", "/concepts/frames"],
  frames: ["Frames", "gpu.frame() encodes your passes and submits once; gpu.frame.loop() drives animation.", "/concepts/passes", "/concepts/render-bundles"],
  "render-bundles": ["Render bundles", "gpu.bundle() records draws once; replaying them each frame skips re-encoding.", "/concepts/frames", undefined],
} as const;
const headingIds = {
  context: ["create-resources-once-draw-every-frame"],
  draws: ["draw-a-mesh", "no-mesh-you-spawn-triangles"],
  compilation: ["pre-warming-with-a-target", "compiling-without-a-target", "compilesync", "errors", "render-bundles"],
  effects: ["updating-bindings"],
  passes: ["one-shader-draw-it-directly"],
  frames: ["render-a-single-frame", "render-loops"],
  "render-bundles": ["record-once-replay-every-frame", "compilation-at-record-time", "mix-recorded-and-dynamic-draws", "resizes-and-sampled-targets", "when-not-to-bother"],
} as const;

test("concept routes are fixed to the seven canonical docs in website order", () => {
  expect(Object.keys(CONCEPT_FILES)).toEqual(slugs);
  expect(Object.values(CONCEPT_FILES)).toEqual(slugs.map((slug) => `../../docs/topics/concepts-${slug}.docs.md`));

  const previousCwd = process.cwd();
  process.chdir(resolve(root, "apps/docs"));
  try {
    expect(conceptSlugs()).toEqual(slugs);
    for (const slug of slugs) {
      const page = getConceptPage(slug);
      expect(page, slug).not.toBeNull();
      const [title, summary, prev, next] = metadata[slug as keyof typeof metadata];
      expect(page?.frontmatter.title).toBe(title);
      expect(page?.frontmatter.summary).toBe(summary);
      expect(page?.frontmatter.prevNext?.prev?.href).toBe(prev);
      expect(page?.frontmatter.prevNext?.next?.href).toBe(next);
      expect(page?.headings.map((heading) => heading.id)).toEqual(headingIds[slug as keyof typeof headingIds]);
    }
    expect(getConceptPage("performance-model")).toBeNull();
  } finally {
    process.chdir(previousCwd);
  }
});

test("concept navigation remains the frozen title and route tuple", () => {
  const source = readFileSync(resolve(root, "apps/docs/lib/nav.ts"), "utf8");
  const conceptsSection = source.slice(source.indexOf("title: 'Concepts'"), source.indexOf("title: 'Guides'"));
  const projected = [...conceptsSection.matchAll(/\{ title: '([^']+)', href: '(\/concepts\/[^']+)' \}/gu)]
    .map((match) => [match[1], match[2]]);
  expect(projected).toEqual(nav);
});

test("legacy concept MDX sources are absent", () => {
  const legacyDir = resolve(root, "apps/docs/content/concepts");
  const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((file) => file.endsWith(".mdx")) : [];
  expect(legacy).toEqual([]);
});
