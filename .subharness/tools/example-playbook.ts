// How to build an apps/docs gallery example, distilled for the example-builder specialist so it does
// not have to rediscover the contract, the registration points, or the verification loop each run.
// The lead revises this file after every example from the builder's retrospective.

export const examplePlaybook = `
# Building a vgpu docs gallery example

Paths below are relative to apps/docs unless they start at the repo root.

## Deliverable: examples/<slug>/
- index.tsx — \`'use client'\`; \`export function Example()\` plus the literal line
  \`export default Example;\` (a test greps for it). Canonical body: a \`relative h-full w-full
  overflow-hidden bg-black\` root div, a \`block h-full w-full touch-none\` canvas, and a useEffect that
  calls \`const renderer = createRenderer({ canvas, container })\`, does \`void renderer.ready\` (the
  rejection stays unhandled on purpose so the preview host shows its "Preview error" overlay), and
  returns \`() => renderer.dispose()\`. No example-specific error reporting. Keep it a thin
  mount/cleanup wrapper; when the example's subject is DOM content (Motion-animated elements), that
  content may live here or in sibling .tsx files, but GPU code stays in renderer.ts and friends.
- renderer.ts — \`createRenderer({ canvas, container? })\` returns \`{ ready, dispose }\` synchronously:
  - \`ready = initialize().catch(...)\`; after every await check a \`disposed\` flag and dispose a GPU
    that arrives late; on failure dispose and rethrow.
  - \`surface(gpu, canvas, { dpr: [1, 2] })\`; the surface auto-resizes; subscribe with
    \`output.onResize(cb)\` (called immediately, then on change; never call frame() inside it).
  - \`dispose\` is idempotent: remove listeners/observers, destroy lil-gui, cancel Motion frame
    callbacks/animations, then \`gpu.dispose()\` (it releases every vgpu child — do not dispose them
    one by one).
  - renderer.ts must not contain the identifier \`renderThumbnail\` (a test checks).
  - Reduced motion: \`window.matchMedia('(prefers-reduced-motion: reduce)')\` and/or Motion's
    useReducedMotion; provide a calmer path, not a frozen page.
- GPU code shared by the live renderer and the thumbnail goes in its own module (e.g. scene.ts /
  pipeline.ts / simulation.ts) that imports nothing DOM-bound: everything reachable from
  render-thumbnail.ts is bundled by esbuild and executed in Node.
- Shaders: .wgsl files imported as \`import source from './name.wgsl'\`. Filenames kebab-case.
  Published files may import packages (vgpu, motion, lil-gui, react) and files inside the example
  directory only — never app helpers or another example; no node: imports outside the thumbnail
  (\`node scripts/check-example-imports.mjs\`).
- meta.ts — \`export const meta = { slug, title, description, tags, capabilities, files, thumb? } as const;\`
  with plain string/array literals (ingest reads the AST; no concatenation). \`files\` = published
  sources in reading order, index.tsx first, must include renderer.ts, must NOT include
  render-thumbnail.ts or tests. tags/capabilities come from
  lib/examples-api/vocabulary/{tags,capabilities}.json; add missing terms (kebab-case, keep the
  files sorted) — current vocabulary has no motion/spring/drag/layout/gesture/sdf/refraction/glass/
  metaball/liquid. Gallery cards show the first 3 tags. \`thumb\` options: warmupFrames, time, dt,
  requiredLimits.
- render-thumbnail.ts — \`export async function renderThumbnail(gpu: Gpu, target: Target, options: Options = {}): Promise<void>\`
  (a function declaration, not an arrow const). The script passes \`{ warmupFrames, dt, time,
  publicAssetsRoot }\` (warmupFrames defaults to 60, 3 in proof mode; dt 1/60) and a fresh headless
  Gpu with an \`rgba8unorm\` Target (no depth) at 1280×720 (card) and 1600×900 (hero). Advance time
  explicitly per frame, render deterministic synthetic inputs through the real pipeline, and in
  \`finally\` await \`Promise.allSettled([Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
  Promise.resolve().then(() => gpu.settled())])\`; never dispose the Gpu there. Luma variance must be
  ≥ 6. It may import node: modules and pngjs.
- Tests (*.test.ts only, node environment — no jsdom; stub window/rAF/ResizeObserver/document with
  vi.stubGlobal): renderer.test.ts using the house pattern that routes vgpu free functions to
  per-test GPU doubles (copy examples/gradient/renderer.test.ts; spiral-galaxy/renderer.test.ts shows
  a lil-gui fake and a frame() mock that runs its callback). Cover: late init after dispose,
  init failure rejects ready and disposes, dispose idempotent and removes listeners/GUI/Motion
  callbacks, thumbnail waits for both drains. Unit-test non-trivial pure modules (maths, LUT baking,
  layout packing). lib/example-foundation.test.ts imports every index.tsx graph in Node, so module
  top levels must not touch window/document.

## Registration
1. lib/example-slugs.ts — append the slug (order = gallery order).
2. lib/example-components.ts — \`'<slug>': () => import('../examples/<slug>/index'),\`.
3. lib/examples-metadata.ts — import the meta; add it to \`rawMetadata\` and
   \`'<slug>': withThumbnails(rawMetadata['<slug>'])\` to \`exampleMetadataBySlug\`.
4. lib/example-foundation.test.ts — bump \`expect(exampleSlugs).toHaveLength(N)\`.
5. scripts/example-chunk-budgets.json — \`examples.<slug>\` gzip bytes plus a \`$comment:<slug>\`
   (how it was measured: Node/Next versions, what dominates). The checker requires exact slug
   coverage and fails on stale chunks, so measure from a production build made after the last edit.
6. public/examples/<slug>.card.png + .hero.png (see Thumbnails).
7. \`node scripts/ingest-examples.mjs\` regenerates lib/examples-source.generated.ts and
   lib/example-thumbs.generated.ts (the thumbs entry appears only once both PNGs exist). Re-run after
   any change to published files or PNGs; commit both outputs.

## See it running — capture_preview
The docs dev server runs from this checkout (the tool reuses or starts it; URL in
.context/docs-dev.json). \`capture_preview\` loads /preview/<slug> in headless Chrome with a real
WebGPU adapter (Apple Metal here) and returns screenshots as images plus console problems, the
preview error overlay, Next dev errors (\`nextOverlay\`), pixel stats (\`uniform: true\` = black or
failed frame), eval results, and frame timing (\`fps\` step).
- A new route compiles on first load (tens of seconds). A missing registration shows a 404 or a
  Next error.
- Viewports that matter: fullscreen preview (1280×720), the gallery detail page's 16:9 iframe
  (832×468 — most visitors see this), and a phone (390×844).
- Script real interactions: \`drag\` with a short durationMs is a flick (Motion drag inertia sees the
  velocity); \`click\` accepts a CSS selector; \`eval\` reads live state — give DOM elements stable
  data-* attributes to target and inspect them. Take several screenshots across time (idle,
  mid-gesture, settle) to judge animation, not one frame.
- Be your own art director: compare every frame with the brief, fix composition, contrast, colour,
  legibility of DOM text over the GPU layer, aliasing, banding, and jank; iterate until it is
  flagship quality, then check \`fps\` (avg ≤ 17 ms at 1280×720).
- Humans can run the same capture: \`node .subharness/tools/preview/cli.ts <slug> --steps '<json>'\`
  (repo root).

## Motion (installed: motion 12.43.0 in apps/docs; no existing example uses it)
- React API: \`motion/react\` (motion.div, layout, layoutId, LayoutGroup, AnimatePresence, drag props,
  useMotionValue, useSpring, useVelocity, useTransform, useAnimate, useReducedMotion, MotionConfig).
  Vanilla: \`motion\` (animate + sequences/controls, spring, stagger, frame/cancelFrame, frameData,
  motionValue, springValue, hover, press, inView, scroll, transform, mix). Read the installed
  declarations before relying on an API (repo root):
  node_modules/.pnpm/motion-dom@12.43.0/node_modules/motion-dom/dist/index.d.ts (primitives) and
  node_modules/.pnpm/framer-motion@12.43.0*/node_modules/framer-motion/dist/index.d.ts (React).
  WebFetch motion.dev docs when behaviour is unclear.
- Per-frame bridge: never push per-frame values through React state. Read motion values (\`.get()\`,
  \`.getVelocity()\`) or DOM rects inside one frame callback and write vgpu uniforms/storage there.
- One clock: docs/topics/external-ticker.docs.md shows driving vgpu from Motion's frameloop —
  \`frame.render(tick, true)\` (keepAlive) with \`clock(gpu).advance(frameData.delta / 1000)\` and
  \`frame(gpu, ...)\` instead of frameLoop — so GPU frames and Motion's style writes land in the same
  browser frame. Motion's steps run read → resolveKeyframes → preUpdate → update → preRender →
  render → postRender; styles are written in render, so read DOM geometry in postRender when the GPU
  needs the final layout. Cancel with \`cancelFrame(tick)\` on dispose.

## Controls
lil-gui (0.21, installed) for tweakables and actions (functions become buttons):
\`new GUI({ title, container, width })\` with \`Object.assign(gui.domElement.style, { position: 'absolute',
top: '16px', right: '16px', zIndex: '10' })\` inside the example root; start it closed on narrow
viewports; \`gui.destroy()\` in dispose. Never build custom HTML/React control panels.

## GPU rules that CI enforces
- Never hardcode a canvas format; compile/prewarm output effects with \`{ colors: [output.format] }\`.
- CI renders thumbnails on Mesa lavapipe in compatibility mode: no textureLoad on depth textures,
  integer hashes (pcg) instead of fract(sin(x) * k), default limits unless meta.thumb requests more
  (storage buffers in the vertex stage need
  \`requiredLimits: { maxStorageBuffersInVertexStage: 1 }\` in both init() and meta.thumb, like
  spiral-galaxy).
- Read the vgpu docs for every API you use: \`pnpm exec vgpu docs cat <page>\` inside apps/docs
  (concepts-frames.md, concepts-passes.md, concepts-effects.md, concepts-draws.md, compute.md,
  effect.md, draw.md, target.md, uniforms.md, surface.md, clock.md, external-ticker.md,
  performance-patterns.md). Reference implementations: examples/fluid (compute solver, pointer
  input), examples/spiral-galaxy (compute particles, instanced quads, HDR bloom chain, lil-gui,
  thorough tests).

## Thumbnails
- Quick local proof (macOS Metal): \`node scripts/render-example-thumbs.mjs --proof-dir /tmp/<slug>-proof --only <slug>\`
  inside apps/docs, then Read the PNG.
- Baselines must match CI's Mesa renderer: from the repo root run \`pnpm thumbs:docker --only <slug>\`
  (Docker build of the lavapipe image; slow the first time), Read both PNGs, and commit them. Never
  regenerate other examples' baselines.

## Verification before committing (repo root unless noted; fix everything)
- \`pnpm exec vitest run apps/docs/examples/<slug> apps/docs/lib/example-foundation.test.ts apps/docs/lib/example-actions.test.ts apps/docs/scripts/validate-example-vocabulary.test.ts\`
- \`node apps/docs/scripts/check-example-imports.mjs\` and \`node apps/docs/scripts/validate-example-vocabulary.mjs\`
- \`pnpm check:filenames\`
- \`pnpm --filter docs build\` then \`pnpm --filter docs check:example-bundles\` — the production build
  typechecks apps/docs and takes several minutes; run it once the code is stable and again only if
  sources change.
- A final capture_preview pass at 1280×720, 832×468 and 390×844 with zero console problems.
`.trim();
