# Plan: document the homepage "adaptive quality" technique for vgpu users

Goal: users (and agents reading the vgpu skill) can ask for "a hero that drops to a cheaper
render path on weak GPUs, low battery, or sustained FPS drops" and get a correct implementation
built on vgpu primitives, without reading the prism-background source.

## 1. What the homepage actually does

Source: `apps/docs/app/[lang]/(home)/components/prism-background/`.

| Piece | File | Depends on prism? | Role |
|---|---|---|---|
| Frame health policy | `performance/frame-health.ts` | No | Pure rolling-window FPS health monitor |
| Signal orchestrator | `performance/auto-quality.ts` | Only the `PrismQualityReason` type | GPU tier + battery + health → one `onDowngrade(reason)` |
| Quality state machine | `renderer.ts` (~lines 155–430) | Yes | preference/effective/reason, deferred start, DPR + pipeline swap |
| Pipeline swap | `pipeline-controller.ts` | Yes (`PrismRuntime`) | Build candidate off-screen, prepare, atomic swap, destroy previous |
| "Low" definition | `pipelines/quality.ts`, `LOW_QUALITY_DPR` | Yes | DPR 1, 64 spectral samples / 12 slices, 2 bloom levels, weaker bloom |
| Benchmark hosting | `scripts/prepare-prism-gpu-benchmarks.mjs`, `public/prism-gpu-benchmarks`, `proxy.ts` matcher | Yes (path) | Same-origin, pinned detect-gpu vendor tables |

### Design decisions that make the technique work

1. **Start High, downgrade once, never upgrade.** No hysteresis, no oscillation, no re-prepare storms.
   The controller disposes itself after the downgrade.
2. **Every signal is advisory.** detect-gpu import failure, missing Battery API, blocked benchmark
   fetch: all log and keep High.
3. **Nothing runs before the first presented High frame.** Auto-quality is a dynamic import scheduled
   with `requestAnimationFrame` + `setTimeout(0)` after the first good frame; detect-gpu is a second
   dynamic import inside it. First paint pays zero.
4. **Health measures presented frames against the workload's own target**, not raw rAF rate.
   `active` and `rendered` flags let intentional 30 FPS caps (ambient dust, mobile) pass;
   gaps > 250 ms (hidden tab) reset the window; refresh rate is estimated from a stable median and
   never lowered; downgrade when observed < 80% of target over a 2 s active window.
5. **Policies are pure exported functions** (`gpuTierRequestsLow`, `batteryRequestsLow`, the
   health monitor) with test seams (`navigator`, `loadGpuTier`, `healthMonitor`, `logger`).
6. **Pipeline swap is prepared off-screen**: the Low pipeline is created and `prepare()`d while
   High keeps rendering; then swap in one tick and destroy High. Stale candidates are discarded if
   the request changed mid-flight.
7. **Low is a real cheaper pipeline, not just DPR.** DPR drop plus fewer passes/levels/samples.
8. **Three-part state for UI and debugging**: `preference` (auto/high/low), `effective`, `reason`
   (`initial | forced | gpu-tier | battery | runtime`), plus structured console logs.

### Reusable as-is vs. site-specific

- Reusable with a rename: `frame-health.ts` (whole file), `auto-quality.ts` (drop the Prism type,
  make the benchmarks URL an option), the reconcile loop shape in `pipeline-controller.ts`.
- Site-specific: `PrismRuntime`, light-mesh layouts, bloom config, the `?prism-perf` sampler,
  the mobile auto-pointer, the debug graph.

## 2. Abstraction options

### Option A: topic guide (docs + skill), no library code

Add `docs/topics/adaptive-quality.docs.md`. Guides under `docs/topics` are auto-discovered by
`packages/vgpu/lib/docs/generate/generate.js`, so the skill, the MCP `docs cat`, and
`apps/docs/content/docs/guides` pick it up on regeneration. Add the slug to the "Performance"
group in `docs/nav.json` (and refresh `docs/nav-curation.snapshot.json` if the test requires it).

Contents (narrative, snippets must compile under `pnpm docs:verify-snippets`):

1. When to use: continuous hero/background renders, not one-shot images.
2. The one-way High → Low model and why (item 1 above).
3. Three signals, each in its own section with a copy-pasteable pure policy:
   - GPU tier with `@pmndrs/detect-gpu`: dynamic import, `benchmarksURL` same-origin, the
     `isMobile || BLOCKLISTED || (BENCHMARK && tier <= 1)` rule, staging script pattern.
   - Battery: `navigator.getBattery`, ≤ 0.3 and not charging, listen to `levelchange`/`chargingchange`.
   - Frame health: the monitor from `frame-health.ts`, fed from `frameLoop` with
     `clock(gpu).deltaTime * 1000`, `active`, `rendered`, workload target.
4. Applying Low with vgpu primitives:
   - `surface.resize([w * dpr, h * dpr])` for the DPR drop (or recreate with `dpr` option).
   - Build the Low variant (`effect`/`draw` with cheaper constants, fewer passes) and
     `await draw.compile(target)` before swapping so the swap frame has no pipeline hitch.
   - Swap inside the same `frameLoop` callback; dispose High after the first Low frame.
   - Keep a `{ preference, effective, reason }` state and a forced `?quality=low` override.
5. Deferring detection until after the first presented frame (rAF + setTimeout + dynamic import).
6. Anti-patterns: measuring rAF rate instead of presented frames, upgrading back automatically,
   requesting detect-gpu on first paint, calling `getBattery` without a feature check, fetching
   benchmarks from unpkg in production.
7. Testing: mock `navigator`, inject `loadGpuTier`, drive the health monitor with synthetic
   samples (mirror `frame-health.test.ts` and `auto-quality.test.ts`).

Cost: one guide plus regeneration. Risk: agents still hand-roll the monitor; snippets must be
kept short enough to be copied faithfully.

### Option B: Option A plus a gallery example

Add `apps/docs/examples/adaptive-quality/` following the existing contract (`meta.ts`,
`index.tsx`, `renderer.ts`, `render-thumbnail.ts`, `renderer.test.ts`, WGSL files). The example:

- Renders one scene in two tiers (e.g. full-res multi-pass bloom vs. DPR-1 single pass).
- Ships `frame-health.ts` and `quality-signals.ts` as example files, generic names, no Prism types.
- Exposes a small overlay showing `effective` + `reason`, and a button to force Low for demos.
- Thumbnail renders the High tier deterministically (no detection during thumbnail).
- Lists new capabilities in `meta.ts` if the gallery filters on them (e.g. `adaptive-quality`).

Cost: medium. Benefit: the examples API and MCP expose canonical code agents copy verbatim,
which is how the rest of the gallery is used today.

### Option C: library subpath (`@vgpu/render/adaptive` or similar)

`frameHealth()`, `qualitySignals({ gpuTier, battery, health, onDowngrade })`, and a
`qualityController` factory. Not recommended now:

- Pulls a third-party dependency (`@pmndrs/detect-gpu`) and its benchmark-hosting story into the
  library, while the skill describes `@vgpu/render` subpaths as slim tooling.
- Browser-only APIs (`navigator.getBattery`, rAF) do not fit `vgpu/node` or `vgpu/mock`.
- The pipeline swap is app-shaped; a generic controller would either be trivial or leak into
  render graph design.

Revisit after the guide exists and real user requests show what they keep re-implementing.

## 3. Recommendation and sequencing

1. **Extract-in-place refactor (small, safe)**: remove the `PrismQualityReason` import from
   `auto-quality.ts` (define a local `AutoQualityReason`), make `benchmarksURL` an option with the
   current default, and keep tests green. This proves the two files are reusable and gives the
   guide real code to quote.
2. **Option A guide** (`docs/topics/adaptive-quality.docs.md`), nav entry, regenerate docs and
   skill with `pnpm -F @vgpu/cli generate:docs`, run `pnpm docs:verify-snippets` and
   `pnpm check:skill-drift`.
3. **Option B example** in a follow-up PR, reusing the same two files so docs and example never
   drift.
4. Mention the guide from `performance-playbook.docs.md` ("See also") and from the homepage hero
   copy link if one exists.

## 4. Open questions

- The hero copy quoted by the request ("Monitors battery level", "Detects your GPU tier",
  "Watches for FPS drops") was not found in the repo; confirm where it lives before linking.
- Should the guide recommend `@pmndrs/detect-gpu` by name, or present it as one option beside
  WebGPU adapter info (`adapter.info`) and the `isMobile` UA heuristic? Current homepage relies
  on detect-gpu plus vendored benchmarks; the guide should at least warn about the hosting step.
- Whether the docs site tests that pin the nav structure (`nav-curation.snapshot.json`,
  `url-inventory.json`) need updating when a topic is added; check on step 2.
