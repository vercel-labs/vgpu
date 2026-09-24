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
  mount/cleanup wrapper. When the subject is DOM content (Motion-animated elements) that content may
  live in sibling .tsx files, and React and the renderer may share a DOM-free store created in
  index.tsx with \`useState(createStore)\` and passed as \`createRenderer({ canvas, container, store })\`.
  Put \`aria-hidden="true"\` on the canvas when the DOM carries the content.
- renderer.ts — \`createRenderer({ canvas, container?, ... })\` returns \`{ ready, dispose }\` synchronously:
  - \`ready = initialize().catch(...)\`; after every await check a \`disposed\` flag and dispose a GPU
    that arrives late; on failure dispose and rethrow.
  - \`surface(gpu, canvas, { dpr: [1, 2] })\`; the surface auto-resizes; subscribe with
    \`output.onResize(cb)\` (called immediately, then on change; never call frame() inside it).
  - \`dispose\` is idempotent: remove listeners/observers, destroy lil-gui, cancel Motion frame
    callbacks/animations, then \`gpu.dispose()\` (it releases every vgpu child — do not dispose them
    one by one).
  - renderer.ts must not contain the identifier \`renderThumbnail\` (a test checks).
  - Reduced motion: \`window.matchMedia('(prefers-reduced-motion: reduce)')\` (listen for \`change\`
    too) and/or Motion's useReducedMotion; provide a calmer path, not a frozen page.
- GPU code shared by the live renderer and the thumbnail goes in its own module (e.g. pipeline.ts /
  simulation.ts) that imports nothing DOM-bound: everything reachable from render-thumbnail.ts is
  bundled by esbuild and executed in Node.
- Shaders: .wgsl files imported as \`import source from './name.wgsl'\`. Filenames kebab-case.
  Published files may import packages (vgpu, motion, lil-gui, react) and files inside the example
  directory only — never app helpers or another example; no node: imports outside the thumbnail.
- meta.ts — \`export const meta = { slug, title, description, tags, capabilities, files, thumb? } as const;\`
  with plain string/array literals (ingest reads the AST; no concatenation). \`files\` = published
  sources in reading order, index.tsx first, must include renderer.ts, must NOT include
  render-thumbnail.ts or tests. tags/capabilities come from
  lib/examples-api/vocabulary/{tags,capabilities}.json; add missing terms (kebab-case, keep the
  files sorted). Gallery cards show the first 3 tags. \`thumb\`: warmupFrames, time, dt,
  requiredLimits.
- render-thumbnail.ts — \`export async function renderThumbnail(gpu: Gpu, target: Target, options: Options = {}): Promise<void>\`
  (a function declaration, not an arrow const). The script passes \`{ warmupFrames, dt, time,
  publicAssetsRoot }\` (warmupFrames defaults to 60, 3 in proof mode; dt 1/60) and a fresh headless
  Gpu with an \`rgba8unorm\` Target (no depth) at 1280×720 (card) and 1600×900 (hero). Advance time
  explicitly per frame, render deterministic synthetic inputs through the real pipeline, and in
  \`finally\` await \`Promise.allSettled([Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
  Promise.resolve().then(() => gpu.settled())])\`; never dispose the Gpu there. Luma variance must be
  ≥ 6. It may import node: modules and pngjs.
- Tests (*.test.ts only, node environment — no jsdom, so keep React thin and test stores and pure
  modules; stub window/rAF/ResizeObserver/document with vi.stubGlobal): renderer.test.ts using the
  house pattern that routes vgpu free functions to per-test GPU doubles (copy
  examples/gradient/renderer.test.ts; spiral-galaxy/renderer.test.ts shows a lil-gui fake and a
  frame() mock that runs its callback). Cover: late init after dispose, init failure rejects ready
  and disposes, dispose idempotent and releases listeners/GUI/Motion callbacks, thumbnail waits for
  both drains. lib/example-foundation.test.ts imports every index.tsx graph in Node, so module top
  levels must not touch window/document.

## Registration
1. lib/example-slugs.ts — append the slug (order = gallery order).
2. lib/example-components.ts — \`'<slug>': () => import('../examples/<slug>/index'),\`.
3. lib/examples-metadata.ts — import the meta; add it to \`rawMetadata\` and
   \`'<slug>': withThumbnails(rawMetadata['<slug>'])\` to \`exampleMetadataBySlug\`.
4. lib/example-foundation.test.ts — bump \`expect(exampleSlugs).toHaveLength(N)\`.
5. scripts/example-chunk-budgets.json — \`examples.<slug>\` gzip bytes plus a \`$comment:<slug>\` (how
   it was measured, what dominates). Put it in the same commit as the example: the checker requires
   exact slug coverage, so a commit without it fails CI.
6. public/examples/<slug>.card.png + .hero.png (see Thumbnails).
7. \`node scripts/ingest-examples.mjs\` regenerates lib/examples-source.generated.ts and
   lib/example-thumbs.generated.ts (the thumbs entry appears only once both PNGs exist). Re-run after
   any change to published files or PNGs; commit both outputs.

## Tools
- capture_preview — /preview/<slug> in headless Chrome with a real WebGPU adapter (Apple Metal
  here). Screenshots and burst contact sheets come back as images, with console problems, the
  preview error overlay, Next dev errors, pixel stats (\`uniform: true\` = black or failed frame), the
  focused element per shot, eval/rects/gui results, and perf.
  - Viewports that matter: fullscreen 1280×720, the gallery detail page's 16:9 iframe 832×468 (most
    visitors see this), a phone 390×844 with \`touch: true\` and \`pointer: "touch"\` steps.
  - Performance: default dpr is 1; run a \`perf\` step at \`dpr: 2\`. \`frameMs\` is vsync-capped;
    \`gpuSubmitToDoneMs\` approximates GPU time per submit (an upper bound) and is the number to budget.
  - Animation: a \`burst\` (e.g. 12 frames every 50 ms) shows a gesture or transition in one image;
    \`gui\` sets lil-gui controllers by label to compare variants without editing code; \`rects\` and
    element anchors (\`{ selector, at }\`) target things that move; \`key\` Enter/Space activate buttons.
  - Humans can run the same capture: \`node .subharness/tools/preview/cli.ts <slug> --dpr 2 --steps '<json>'\`.
- render_thumbnail — card + hero through render-thumbnail.ts on the local GPU in ~2 s, into
  .context/thumbs/<slug>/, with determinism (\`repeat: 2\`) and drift from the committed baselines.
  Use it to pick the thumbnail moment.
- \`node .subharness/tools/thumbs/mesa.ts <slug> [--update]\` (Bash; background it) — CI's exact
  thumbnail renderer: the pinned linux/amd64 Mesa lavapipe image from infra/snapshots/Dockerfile, in
  a long-lived container that keeps its install and build. The first run in a checkout takes
  ~2 minutes; later runs sync sources and rebuild incrementally. Without --update it runs
  \`thumbs:check\` against your PNGs and saves diffs to .context/thumbs/<slug>/ on failure.
  (\`pnpm thumbs:docker\` is broken: its image runs the test suite, which needs git.)
- verify_example — the pre-commit checklist in one call (~10 s): focused vitest, import boundaries,
  vocabulary, filenames, apps/docs typecheck, ingest (commit what it regenerates), budget entry and
  PNGs present, and tree hygiene.
- bundle_report — after \`pnpm --filter docs build\`: every route's gzip vs budget in one pass (the repo
  checker stops at the first failure), shared chunks, the delta against the latest green canary CI
  run, and a proposed budget entry.

## Motion (installed: motion 12.43.0 in apps/docs)
- React API: \`motion/react\` (motion.div, layout, layoutId, LayoutGroup, AnimatePresence, drag props,
  useMotionValue, useSpring, useVelocity, useTransform, useAnimate, useReducedMotion, MotionConfig,
  LazyMotion/m). Vanilla: \`motion\` (animate + sequences/controls, spring, stagger, frame/cancelFrame,
  frameData, motionValue, springValue, hover, press, inView, scroll, transform, mix). Declarations
  (repo root): node_modules/.pnpm/motion-dom@12.43.0/node_modules/motion-dom/dist/index.d.ts
  (primitives) and node_modules/.pnpm/framer-motion@12.43.0*/node_modules/framer-motion/dist/index.d.ts
  (React). WebFetch motion.dev docs when behaviour is unclear.
- Size: motion/react with layout, drag and presence cost ~45 KB gzip in liquid-layout. Use vanilla
  \`motion\` when no React-only feature is needed. Drag exists only in motion/react (no vanilla drag
  gesture in 12.43).
- Per-frame bridge: never push per-frame values through React state. Read motion values (\`.get()\`,
  \`.getVelocity()\`) or DOM rects inside one frame callback and write vgpu uniforms/storage there.
- One clock: drive vgpu from Motion's frameloop instead of frameLoop — \`frame.render(tick, true)\`
  (keepAlive), or \`frame.postRender(tick, true)\` when the GPU needs final DOM geometry (Motion writes
  styles in render; its steps run read → resolveKeyframes → preUpdate → update → preRender → render →
  postRender). In the tick: \`clock(gpu).advance(Math.min(frameData.delta, 50) / 1000)\` (delta spikes
  after a hidden tab), then \`frame(gpu, ...)\`. Cancel with \`cancelFrame(tick)\` on dispose. Wrap
  the tick so a throwing frame disposes once and rethrows via \`queueMicrotask\` — otherwise it throws
  every frame. (docs/topics/external-ticker.docs.md shows the pattern with \`frame.update\`.)
- Gestures and layout facts: \`getBoundingClientRect()\` read in postRender includes that frame's
  FLIP transforms, but for a rotated element it is the axis-aligned box (un-rotate with its \`rotate\`
  value). A mouse drag ends with a \`click\` on the dragged element (set a flag in onDragStart, clear
  it in onClick). Motion's press synthesises pointer events for Enter; Space goes straight to
  onClick. Hover ignores touch pointers. During a layoutId handoff both elements exist at once — key
  registries by id and let an unmount remove only its own handle. \`MotionConfig reducedMotion="user"\`
  skips transform/layout animations but still runs opacity.

## DOM content, idle choreography, and controls
- An idle/autoplay choreography (so the gallery card is alive) must pause while the pointer is over
  the demo, a descendant has :focus-visible, an element is hovered or pressed, or a user-opened
  dialog is open — and must never move focus or replace the focused element.
- A dialog that leaves the lil-gui controls reachable is non-modal: no \`aria-modal\`.
- lil-gui (0.21, installed) for tweakables and actions (functions become buttons):
  \`new GUI({ title, container, width })\` with \`Object.assign(gui.domElement.style, { position: 'absolute',
  top: '16px', right: '16px', zIndex: '10' })\` inside the example root; start it closed when it would
  cover content (narrow viewports); \`gui.destroy()\` in dispose. Sync programmatic changes with
  \`controller.updateDisplay()\`, not \`.listen()\` (it polls every frame). Never build custom HTML/React
  control panels.

## GPU rules
- Never hardcode a canvas format; compile/prewarm output effects with \`{ colors: [output.format] }\`.
- CI renders thumbnails on Mesa lavapipe (a CPU renderer) in compatibility mode: no textureLoad on
  depth textures, integer hashes (pcg) instead of fract(sin(x) * k), default limits unless meta.thumb
  requests more (storage buffers in the vertex stage need
  \`requiredLimits: { maxStorageBuffersInVertexStage: 1 }\` in both init() and meta.thumb, like
  spiral-galaxy).
- \`r32float\`, \`rg32float\` and \`rgba32float\` cannot be sampled with linear filtering without the
  float32-filterable feature — use \`rgba16float\` for fields sampled bilinearly (fluid dye/velocity).
- Thumbnails must be deterministic run to run: make particle state a closed-form function of time
  where possible (and keep meta.thumb.warmupFrames low — lavapipe is slow at 1600×900), drive
  simulations with a fixed dt and fixed iteration counts, never read unwritten targets, and splat
  with fixed-point \`atomicAdd\` on i32/u32 (WGSL has no float atomics).
- Budget: at 1280×720 dpr 2 on this Mac, keep \`gpuSubmitToDoneMs\` p95 ≤ 8 ms (liquid-layout: ~6 ms).
  Expose quality/count in lil-gui and default to what meets the budget.
- Read the vgpu docs for every API you use: \`pnpm exec vgpu docs cat <page>\` inside apps/docs
  (concepts-frames.md, concepts-passes.md, concepts-effects.md, concepts-draws.md, compute.md,
  effect.md, draw.md, target.md, uniforms.md, surface.md, clock.md, external-ticker.md,
  performance-patterns.md). References: examples/fluid (compute solver, pointer input),
  examples/spiral-galaxy (compute particles, instanced quads, HDR bloom chain, lil-gui, thorough tests),
  examples/liquid-layout (Motion + DOM + frame.postRender clock, store pattern, idle choreography).

## Thumbnails
- Pick the moment with render_thumbnail (fast, local GPU). Then run the Mesa tool once: without
  --update to check; with --update when the check fails. \`--update\` rewrites a PNG only when it
  differs from the existing one by more than the 2% tolerance, so a baseline rendered anywhere is
  fine if the Mesa check passes. Read both PNGs before committing. Never regenerate other examples'
  baselines.

## Builds and budgets
- \`pnpm --filter docs build\` takes several minutes: run it in the background, once, after the code
  is final. It rewrites apps/docs/next-env.d.ts — \`git checkout apps/docs/next-env.d.ts\` afterwards —
  and \`next dev\` can touch apps/docs/agents.md; never commit either.
- Then bundle_report. Adding an example can shift other routes through chunk factoring (identical
  raw bytes, different gzip); change another route's baseline only if it would exceed its limit in
  CI (check \`ciGzip\` + the shift), and explain it in \`$comment:<slug>-shared-chunks\`. Local gzip
  differs from CI by tens of bytes for some routes (atmosphere reads ~188 B high here and has 30 B of
  CI headroom); that is environmental.
`.trim();
