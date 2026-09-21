---
title: Adaptive quality: switch render pipelines on GPU tier, battery, and FPS
summary: Start every visitor on the High pipeline, then downgrade once to a cheaper Low pipeline when detect-gpu, the Battery Status API, or presented-frame health says the device cannot hold it. Copy the code from the adaptive-quality example.
keywords: adaptive quality, quality tiers, auto quality, low quality fallback, downgrade, detect-gpu, gpu tier, getGPUTier, battery, getBattery, low battery, fps drop, frame drops, frame health, performance monitor, requestAnimationFrame, dpr, device pixel ratio, pipeline swap, two pipelines, hero background, mobile fallback, weak gpu
relatedSymbols:
  - Surface
  - Effect
  - Target
  - frameLoop
  - clock
---

# Adaptive quality: switch render pipelines on GPU tier, battery, and FPS

A hero or ambient background has to look great on a desktop GPU and still run on a three-year-old phone at 20% battery. Guessing a single budget serves neither. The pattern below is what the vgpu homepage does: render the **High** pipeline first, watch three advisory signals, and if any of them asks for it, build a **Low** pipeline off-screen and swap once.

The complete, tested implementation is the [adaptive quality example](/examples/adaptive-quality). Pull it instead of re-typing it:

```sh
npx -y vgpu examples show adaptive-quality                      # files and metadata
npx -y vgpu examples cat adaptive-quality frame-health.ts       # one file
npx -y vgpu examples pull adaptive-quality --out ./adaptive-quality
```

Through MCP the same files are available with the `examples` tool: `show`, `read`, and (on scoped local stdio) `download`, all with `id: "adaptive-quality"`.

## When to use it

This is a production pattern for a render that is **always on screen and always animating**: a hero background, an ambient scene behind content, a canvas that plays for the whole session. It earns its cost there because a stuttering hero is the first thing every visitor sees, and because the devices that struggle (phones, integrated GPUs, laptops on battery) are the ones you cannot test on your own machine.

It is overkill while the render is still being designed. It adds a second pipeline to keep in sync with the first, a dependency, and a hosting step for the benchmark tables. Do not reach for it when:

- the user is experimenting, prototyping, or iterating on the look of a shader;
- the render is on demand or short-lived (a preview, a thumbnail, an interaction that ends);
- the audience is known to be desktop-only;
- the High pipeline has not been optimized yet. Cheaper High first ([Performance playbook](performance-playbook.docs.md)), tiers second.

**For agents:** treat this as something to *offer*, not to add unprompted. When the user asks for a hero or ambient background and mentions production, mobile, "weak devices," or performance, propose it in one sentence and build it if they agree. When they are exploring, leave it out and mention that a Low tier exists for later. If you are unsure, the smallest useful step is `frame-health.ts` plus a DPR drop: it needs no dependency and no second pipeline, and it can grow into the full pattern when the design settles.

## The model in one paragraph

Quality has three parts: the user's **preference** (`auto`, `high`, `low`), the **effective** tier on screen, and the **reason** it is there (`initial`, `forced`, `gpu-tier`, `battery`, `frame-health`). In `auto`, the renderer always starts High. Signals are started only after the first High frame has been presented, every signal is advisory (a failure keeps High), and the only automatic transition is High → Low, once. Nothing ever upgrades on its own, so there is no oscillation and no hysteresis to tune.

## Files to copy

| File in the example | What it is | Depends on your scene? |
| --- | --- | --- |
| `frame-health.ts` | Pure FPS-health policy over presented frames | No |
| `quality-signals.ts` | GPU tier + battery + frame health → one `onDowngrade(reason)` | No |
| `quality-controller.ts` | Requested-vs-active tier reconciliation with off-screen prepare and atomic swap | No |
| `quality.ts` | Tier, preference, reason, and per-tier DPR | No |
| `scene.ts` | What High and Low mean for *this* scene | Yes, replace it |
| `renderer.ts` | Glue: manual surface sizing, frame loop, arming and disposing signals | Mostly reusable |

`frame-health.ts`, `quality-signals.ts`, and `quality-controller.ts` have no imports from the scene. Copy them unchanged, write your own `scene.ts` against the `TierResources` interface, and adapt `renderer.ts`.

## 1. Define what Low means

Low must be a genuinely cheaper pipeline, not just a lower resolution. In the example High is field → HDR target → bright pass → two half-resolution blurs → tone-mapped composite at DPR ≤ 2; Low is the same field shader with a third of the march steps, tone mapping in-shader, straight to the canvas at DPR 1.

Both tiers implement one interface so the controller can build and swap them without knowing anything else:

```ts
import type { Frame } from "vgpu";

type QualityTier = "high" | "low";

interface TierResources {
  /** Allocate and pre-compile everything. Runs while the previous tier keeps rendering. */
  prepare(): Promise<void>;
  destroy(): void;
}

interface Scene extends TierResources {
  readonly tier: QualityTier;
  resize(size: readonly [number, number]): void;
  render(currentFrame: Frame, time: number): void;
}
```

`prepare()` must `await effect.compile(target)` (or `draw.compile(target)`) for every pass against the target it will render into. That is what makes the swap frame hitch-free: by the time Low becomes active, its pipelines already exist. See [Compilation](concepts-compilation.docs.md).

## 2. Own the surface size

Each tier picks its own device pixel ratio, so the canvas surface cannot auto-resize. Create it with `autoResize: false` and drive `resize()` yourself from a `ResizeObserver` and the tier's DPR:

```ts
import { init, surface } from "vgpu";

declare const canvas: HTMLCanvasElement;
declare function tierDpr(tier: "high" | "low", devicePixelRatio: number): number;

const gpu = await init();
const output = surface(gpu, canvas, { autoResize: false, dpr: tierDpr("high", window.devicePixelRatio) });

function applySize(tier: "high" | "low") {
  const { width, height } = canvas.getBoundingClientRect();
  const dpr = tierDpr(tier, window.devicePixelRatio || 1);
  output.resize([Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr))]);
}
```

In the example `tierDpr` clamps High to `[1, 2]` and pins Low to `1`. Resize the new tier's own targets from the same size right before the swap, so its first frame is already at the right resolution.

## 3. Reconcile tiers with a controller

`createQualityController({ createTier, onActivate })` keeps a requested tier and an active tier and runs one loop until they match: create the candidate, `await candidate.prepare()`, check that the request has not changed in the meantime (discard the candidate if it has), call `onActivate(tier, candidate)` for the resize, then swap and destroy the previous tier. It exposes `state`, `subscribe`, `setPreference`, and `downgrade(reason)`; `downgrade` is a no-op unless the preference is `auto` and High is requested.

```text
controller = createQualityController({
  createTier: (tier) => createScene(gpu, output, tier),
  onActivate: (tier, scene) => { applySize(tier); scene.resize(output.size); },
});
await controller.ready;             // High is on screen
frameLoop(gpu, (f) => controller.active?.render(f, clock(gpu).time));
```

## 4. Start the signals after the first frame

Detection must cost the first paint nothing. Arm the signals from inside the frame loop, one `requestAnimationFrame` plus a `setTimeout(0)` after the first presented frame, through a dynamic import so neither the signals module nor detect-gpu lands in the initial chunk. detect-gpu is itself a second dynamic `import()` inside `quality-signals.ts`, so its code (~15 KB gzip) and the vendor benchmark table it fetches are downloaded only after High is already on screen, and only when the preference is `auto`. The initial bundle pays nothing for the feature:

```text
frameLoop(gpu, (f) => {
  controller.active?.render(f, time.time);
  signals?.recordFrame({ deltaMs: time.deltaTime * 1000, active: autoHigh && visible, rendered: true });
  if (autoHigh && !signals && !scheduled) scheduleSignals();   // rAF → setTimeout(0) → import("./quality-signals")
});

signals = createQualitySignals({
  onDowngrade: (reason) => void controller.downgrade(reason),
  benchmarksUrl: "/gpu-benchmarks",   // optional same-origin copy, see below
});
```

Dispose the signals as soon as the state leaves `auto`/High: after a downgrade, or when the user forces a tier. Re-arm them if the preference returns to `auto`.

### GPU tier with detect-gpu

`@pmndrs/detect-gpu` probes WebGL for the renderer string, then fetches one vendor benchmark table and maps it to a tier 0–3. The policy in `gpuTierRequestsLow` is conservative on purpose: request Low for `isMobile`, for `BLOCKLISTED`, and for `BENCHMARK` tiers 0 and 1. `FALLBACK` (unknown GPU) and `BENCHMARK_FETCH_FAILED` keep High, because an unknown desktop GPU is more often new than weak.

The benchmark tables live on detect-gpu's CDN by default. For production, copy `node_modules/@pmndrs/detect-gpu/dist/benchmarks/*.json` into your public directory and pass `benchmarksUrl` so the request is same-origin and pinned to the installed version; the vgpu repo does this in `apps/docs/scripts/prepare-prism-gpu-benchmarks.mjs`. A blocked or failed fetch is logged and ignored.

### Battery

Feature-check `navigator.getBattery` first: it is missing in Safari and Firefox. Request Low when the device is discharging at or below 30% (inclusive), and keep listening to `levelchange` and `chargingchange` so a laptop unplugged mid-session still downgrades. The example's `batteryRequestsLow` is the whole rule.

### Frame health

Do not measure the raw `requestAnimationFrame` rate; measure **presented** frames against the target the workload actually has. `createFrameHealthMonitor()` takes one sample per tick:

| Field | Meaning |
| --- | --- |
| `deltaMs` | Raw rAF interval, from `clock(gpu).deltaTime * 1000` |
| `active` | The renderer had work, the page is visible, and Auto/High is on screen |
| `rendered` | This tick presented a frame (false when a cap or "nothing changed" skipped it) |
| `targetFps` | Optional intentional cap for this tick, for example `30` for an ambient loop |

It estimates the display refresh rate from a stable median (seeded at 60, never lowered, capped at 90), and asks for Low when presented FPS stays below 80% of the target for two seconds of active time. Gaps over 250 ms (hidden tab, idle) reset the window instead of counting as drops. Call `resetHealth()` after a resize or a swap.

## 5. Show the state

Expose `{ preference, effective, reason }` to the UI and log every decision with structured `console.info`. Users can then see *why* they got Low ("GPU tier", "battery", "FPS drops") and force a tier if they disagree. The example's `index.tsx` renders exactly that: a label and three buttons.

## Anti-patterns

- **Upgrading back automatically.** Presented FPS improves the moment Low is active, which would immediately argue for High again. Only the user moves back up.
- **Importing detect-gpu at module scope.** Its code joins your initial bundle, and its WebGL probe and benchmark fetch compete with your first frame. Import it inside the signals module, which is itself imported after the first frame.
- **Judging FPS against the rAF rate.** A deliberate 30 FPS cap or a 120 Hz display both produce false downgrades. Pass `rendered` honestly and `targetFps` when you cap.
- **Swapping before `prepare()` resolves.** Compiling pipelines on the swap frame is the hitch the whole technique exists to avoid.
- **Calling `getBattery()` without a feature check.** It throws where the API is absent.
- **Letting the surface auto-resize.** It re-reads `devicePixelRatio` each frame and overwrites the Low DPR.

## Testing

All three reusable modules have seams: `createQualitySignals` accepts `navigator`, `loadGpuTier`, `healthMonitor`, and `logger`; `createFrameHealthMonitor` is pure, drive it with synthetic `{ deltaMs, active, rendered }` samples; `createQualityController` takes any `createTier` factory, so fake tiers with deferred `prepare()` prove that stale candidates are discarded and the previous tier is destroyed only after the swap. The example ships `frame-health.test.ts`, `quality-signals.test.ts`, `quality-controller.test.ts`, and `renderer.test.ts` as templates.

## See also

- [Adaptive quality example](/examples/adaptive-quality): the code this guide describes.
- [Compilation](concepts-compilation.docs.md): why `prepare()` compiles against the real target.
- [Measuring](measuring.docs.md): confirm a pass is expensive before cutting it from Low.
- [Performance playbook](performance-playbook.docs.md): default shapes that make High cheaper in the first place.
- [Shipping to production](shipping-to-production.docs.md): the pre-PR checklist that decides when to offer a Low tier.
