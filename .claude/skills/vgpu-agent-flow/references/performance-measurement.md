# Measure rendering cost and device activity

Use this workflow to locate CPU/GPU bottlenecks, evaluate a rendering optimization, or explain
device utilization. Start with the user's question and requested device. A browser preview on a
desktop cannot establish performance on a phone or headset. Numeric budgets belong to the task.

## Choose the measurement

| Question | Evidence | What it does not establish |
| --- | --- | --- |
| Is scene update or command encoding expensive? | CPU duration around those synchronous scopes, plus a CPU profile when needed | Total browser/process CPU use or worker cost |
| Which GPU passes are expensive? | GPU timestamp intervals with named pass scopes | Presentation, uninstrumented work or utilization |
| Does the animation stutter? | Frame cadence, missed frames and a matching interaction trace | Whether CPU or GPU caused the stall |
| Why does the first view load slowly? | Cold trace: network, decoding, uploads and pipeline preparation | Warm steady-state cost |
| How busy is the device? | Available OS/device utilization counters over a recorded sample window | Exclusive application cost unless the counter is process-scoped |
| Why is memory high? | Allocated resources, loaded texture formats/mips, CPU staging and supported memory counters | Total residency inferred from download bytes |

For example, low whole-machine CPU utilization can coexist with one saturated main thread. A
large queue-completion delay can include older queued work and JavaScript scheduling. Neither is
proof that a particular shader is slow. Use [WebGPU pass timestamps](https://gpuweb.github.io/types/interfaces/GPURenderPassTimestampWrites.html)
for instrumented GPU work; [queue completion](https://gpuweb.github.io/types/interfaces/GPUQueue.html)
is a synchronization result. Resolve vgpu's `timer` API through the installed package documentation.

`capture_preview` remains a visual/interaction diagnostic. Its schema v2 names queue latency
`queueCompletionMs`, `queueCompletionP95MedianMs` and `queueCompletionP95PerRunMs`; these replace
the old `gpuSubmitToDoneMs`, `gpuP95MedianMs` and `gpuP95PerRunMs` names. Its rAF callback durations
exclude work elsewhere. Windows with unresolved or failed completions do not contribute to the
aggregate queue p95. Raw windows remain in the report. Do not mix old and new reports as GPU timings.

## Bounded browser measurement

The tools in `.subharness/tools/performance/` implement this lifecycle:

1. `perf_cases` reads JSON case descriptions; `perf_plan` validates capability and budget without
   importing scene code, starting servers or touching the GPU.
2. `perf_run` acquires a per-user machine lease, opens one browser, verifies actual scene metadata,
   prepares the scene, measures a finite number of frames, disposes it and closes its browser.
3. `perf_compare` reads reports offline and compares medians across independent blocks. It rejects
   missing, partial, incompatible or unclean evidence. It never substitutes unavailable timings.

The current adapter is a browser bridge described below. Native/headset adapters and OS utilization
samplers are **not implemented by these tools**. Use an existing appropriate device tool or report
the gap; never treat the desktop bridge as physical-headset evidence. The preview launcher uses
SwiftShader on Linux by default; classify software evidence accordingly. Inspect the actual device
used by the scene rather than requesting another adapter just to label a report.

Define a case file, for example `.context/work/chair-perf/case.json`. Values here illustrate the
format; replace source/build, URL and settings with the application under test:

```json
{
  "id": "chair-close-view",
  "url": "http://127.0.0.1:3000/debug/chair",
  "source": "actual-served-source-fingerprint",
  "build": "actual-served-build-id",
  "settings": {
    "width": 1280, "height": 720, "dpr": 1,
    "camera": "front-three-quarter", "quality": "high",
    "seed": 7, "dt": 0, "variant": "baseline"
  },
  "capabilities": {
    "cpu": "scene update and command encoding",
    "gpu": "union of color and shadow pass timestamp intervals"
  }
}
```

Omit unsupported capabilities; a requested omitted mode fails before browser startup. A CPU-only
request uses only `mode: "cpu"`. It can still render on the GPU: the mode controls instrumentation,
not which processor is active. For both metrics, run separate CPU and GPU blocks. Captures are
separate visual work and their duration is never a timing sample.

Agent example: call `perf_plan` with `caseFile`, `mode: "gpu"`, `warmup: 4`, `samples: 24`,
`hz: 15`, `timeoutMs: 60000`, then `perf_run` with the same arguments. These are bounded exploration
defaults, not a statistically sufficient benchmark. The deadline includes browser/scene startup;
cleanup may take additional time. Missing bridges time out with a failed report.

Without an agent, create `plan.json` containing `{ "case": <case object>, "budget": { "mode": "gpu" } }`
and use Node 22.19 or later:

```sh
node --experimental-strip-types .subharness/tools/performance/cli.ts cases .context/work/chair-perf/case.json
node --experimental-strip-types .subharness/tools/performance/cli.ts plan .context/work/chair-perf/plan.json
node --experimental-strip-types .subharness/tools/performance/cli.ts run .context/work/chair-perf/plan.json
```

The raw report is written to a new `.context/performance/<run-id>/report.json`. `compare` takes a
JSON file with `baseline` and `candidate` arrays of report paths, resolved from the caller's cwd.
Agent tools take those arrays directly. Source/build changes are rejected unless
`allowSourceChange: true` explicitly identifies a reviewed implementation comparison. Each side
still needs one consistent source/build/variant, and all other comparison settings must match.

## Implement an application adapter

A debug-only page exposes `globalThis.__vgpuPerf` with three asynchronous methods. Implement it
using the application's existing scene builder, materials and loaders; do not copy the renderer.
The page must start paused and have no independent animation loop during the experiment.

| Method | Input/output | Responsibility |
| --- | --- | --- |
| `prepare(plan)` | Returns metadata below | Apply settings, load/prepare the actual scene, verify capability and install only requested instrumentation |
| `sample({index, dt, mode})` | Returns `{valueMs: number}` | Advance exactly once with the supplied simulation dt, collect the requested scope and reject device loss or invalid samples |
| `dispose()` | Resolves when released | Remove instrumentation and dispose owned resources, including after partial prepare failure |

Metadata has `source`, `build`, `settings` (same shape as the case), `scope`, `method` (`cpu-scopes`
or `gpu-timestamps`), `device`, `backend` (`hardware`, `software`, `synthetic` or `unknown`), `runtime`, and
`buildMode` (`production`, `development` or `test`). Read source/build from the served application
and actual applied settings/device from the scene; echoing the requested values does not verify
them. The host checks identity/settings/scope and appends Chrome's own version/revision.

For CPU mode, measure the documented synchronous update/encode work inside the application, not
the CDP round trip. For GPU mode, await real timestamp results for the sampled frame. If measuring
several overlapping intervals on one device, compute their union; do not double-count overlaps.
Exclude/describe transfers, compute or presentation not covered. Do not use
`onSubmittedWorkDone()` elapsed time as a timestamp fallback. Timestamp readback and instrumentation
can perturb execution; keep that work out of the CPU measurement run.

For example, a chair viewer's adapter can freeze its camera and pose, update the existing scene
once, and collect its color/shadow timestamps. A scene without timestamp-query support declares
CPU only and reports GPU unavailable. The checked-in `scripts/fixtures/performance-scene.html` is
a tiny bridge protocol smoke fixture, not a replacement application renderer or useful benchmark.

Validate an adapter with mocks for lifecycle, missing capability, timeout and cleanup, then one
tiny hardware smoke. State exactly which adapter/device was tested. Do not require a full game or
new GPU campaign for a schema or instruction change.

## Control the experiment

Record source/assets, served build, runner revision, browser/device/backend, camera/pose, actual
drawing-buffer dimensions, DPR, quality, seed, simulation dt, warmup, sample count and cadence.
`width`/`height` in the plan are CSS pixels; the intended drawing buffer is width × DPR by height ×
DPR, and the bridge must reject a mismatch. Keep those settings fixed across matched comparisons.
Run A/B/A/B serially; report block medians and repeat spread, and collect more only when needed to
distinguish a change from noise. Short samples do not establish production p95/p99 or FPS.

A block is one independent bounded run: A is the baseline and B the candidate. Start a fresh agent
session after changing agent definitions or tool code; existing sessions retain loaded definitions.
Reports fingerprint the runner sources at module load, so later edits cannot relabel a running
session as the new implementation.

Wall pacing limits average activity, not instantaneous GPU use. It also changes clocks/cache
behavior. Use an actual application run for frame-rate claims. CPU and GPU work can overlap;
adding their milliseconds does not give whole-frame latency. Likewise, hiding one object changes
occlusion, shadows and shared batches: removal deltas are not additive asset-cost percentages.

All participating runs share a lease under the OS temporary directory, independent of Git
worktree. A contention error reports its owner. Never steal a lease based on age, kill unrelated
processes or retry device loss in a loop. After a crash, inspect the recorded PID and its browser
children and establish that they stopped before manual lease recovery. Preview tools, Blender and
other applications do not use this lease; arrange an exclusive measurement window for them too.

## Measure device utilization separately

Use a platform sampler that actually exposes the requested counter. Inspect its help/schema and
available permissions; do not add a privileged service or change permissions silently. On macOS,
read-only `top` and some drivers' IOAccelerator counters can provide whole-machine CPU/GPU activity,
but support and averaging windows vary. Validate availability on the actual machine. Other OSes
and physical headsets need their corresponding supported tools; there is no browser-only universal
GPU-utilization counter supplied by this workflow.

Preserve raw samples with source, device/process identity, unit, normalization (100% of one core
versus the whole machine), cadence and averaging window. Align monotonic and epoch clocks with
recorded clock pairs when correlating a trace/video. Keep missing samples null with a reason;
do not interpolate future measurements into an earlier stall or clamp multicore CPU percentages.
If only whole-device counters are available, concurrent activity cannot be attributed to this app.

## Turn observations into a useful result

| Observation | Next bounded experiment | Required tradeoff check |
| --- | --- | --- |
| CPU encoding dominates | Compatible instancing, binding reuse or render bundles | Preserve spatial culling and changing data |
| Fragment-heavy pass | Resolution sensitivity, overdraw or material variants | Preserve intended visual quality |
| Geometry/shadow-heavy passes | LODs, bounds or simpler shadow casters | Silhouette, transitions and moving shadows |
| First-use stall | Separate download, decode, upload and pipeline preparation | Startup versus warm-frame cost |
| Growing memory | Resource lifetime and duplicate allocations | Scene replacement, cancellation and disposal |

Label these as hypotheses until tested. A high utilization counter alone does not identify which
shader or object to optimize. A lower triangle count alone does not establish faster rendering.

Deliver findings first: requested scope, measured costs/distributions, sample counts, repeat
variation, failed/unavailable measurements and the next experiment. Link raw JSON and reproducible
commands. Include actual matching runtime screenshots for visual changes, and a compact gallery
or heatmap when comparing many scenes. Scale the report to the task; a single prop does not need
a track map. Use explicit units and budget legends; unmeasured cells stay grey. Report whether
owned browser/monitoring work stopped. A production improvement requires matched before/after
evidence and validation in the real application; diagnostic or synthetic output remains labeled.
