# FastDepth 160×128 — model recipe and real-GPU gate

Phase 0 tooling for the depth-estimation docs example: how the candidate ONNX is
acquired and verified, how it was validated on CPU, and how the author runs the
**blocking real-GPU gate** before any example code is written.

- Audit record and locked contract: [`PROVENANCE.md`](./PROVENANCE.md)
- Fixture image licensing: [`image-credits.md`](./image-credits.md)

## TL;DR

```bash
# 1. stage the model where the example will consume it (Phase 1)
tools/models/fastdepth/acquire.sh

# 2. or stage the untracked gate payload (model + ORT + fixtures) under /depth-gate/
tools/models/fastdepth/stage-gate.sh --cache /tmp/fastdepth-cache

# 3. serve the docs app and open the gate in a browser with a real GPU
pnpm --filter docs dev
open http://localhost:3000/depth-gate/index.html
```

## The candidate

| Field | Value |
| --- | --- |
| Network | FastDepth, final **pruned** MobileNet-NNConv5(depthwise)+skip-add |
| Input | `input.1`, float32 `[1, 3, 128, 160]`, NCHW, `rgb/255` |
| Output | `424`, float32 `[1, 1, 128, 160]`, row-major, **metric depth in metres** |
| Size | 5,420,430 bytes (5.17 MiB) — inside the ≤9 MiB budget |
| SHA-256 | `6cd8060e86d8b92620f49a3687c224565b6b1dd3e7786e396d9c0bdd05310155` |
| Opset | 11, `producer: pytorch 1.9`, 84 nodes (`Conv`, `Clip`, `Relu`, `Resize`, `Add`) |
| License | MIT (`Copyright (c) 2019 Diana Wofk`) |

Neither float16 nor the ≤16 MiB exception is required. `PROVENANCE.md` documents
the lineage audit, the residual audit gap, and the measured evidence that the
normalization is plain `rgb/255` and the output is metric (not inverse) depth.

## Scripts

| Script | What it does |
| --- | --- |
| `acquire.sh` | Downloads the pinned 724 MB PINTO archive to a scratch/cache dir, verifies its SHA-256, extracts **only** `saved_model_128x160/fast_depth_128x160.onnx`, verifies that member's SHA-256, and stages `fastdepth-160x128.onnx` + `LICENSE` + `SHA256SUMS` + `PROVENANCE.md` into `apps/docs/public/models/fastdepth/` (override with `--out`). `--check` re-verifies an already staged directory without downloading. |
| `stage-gate.sh` | Rebuilds the untracked gate payload under `apps/docs/public/depth-gate/`: model, the three pinned `onnxruntime-web` 1.27.0 WebGPU files, and the two licensed fixtures (digest-checked). |
| `validate-cpu.py` | CPU-EP validation: graph audit, normalization comparison, value/layering sanity, `<image>.depth.png` previews. Produces the numbers embedded in `browser.js` as `CPU_REFERENCE`. |

The archive is large; pass `--cache DIR` to keep it between runs.

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/models/fastdepth/requirements.txt
.venv/bin/python tools/models/fastdepth/validate-cpu.py \
  apps/docs/public/depth-gate/model.onnx \
  apps/docs/public/depth-gate/images/room-a.jpg \
  apps/docs/public/depth-gate/images/room-b.jpg
```

## The real-GPU gate

The gate page itself is an **untracked local dev aid**:
`apps/docs/public/depth-gate/.gitignore` contains `*`, exactly like
`public/pose-gate/`. It is fully self-contained under `/depth-gate/` — its own
ORT copy, its own model copy, its own fixtures — so it can never accidentally
pass because of the example's real `/ort/` or `/models/` staging.

Payload:

```text
apps/docs/public/depth-gate/
├── .gitignore          "*"
├── index.html          verdict badge, checks table, previews, evidence <pre>
├── browser.js          the harness
├── model.onnx          5.17 MiB candidate (hash asserted in the page)
├── ort/                ort.webgpu.min.mjs + asyncify .mjs/.wasm (ORT 1.27.0)
└── images/room-{a,b}.jpg
```

### Author procedure

1. `tools/models/fastdepth/stage-gate.sh` (only needed if the payload is missing).
2. `pnpm --filter docs dev`.
3. Open `http://localhost:3000/depth-gate/index.html` in a browser with a **real**
   GPU (Chrome/Edge 121+). **Just open the bare URL** — the defaults are the
   intended configuration: 2 warmups + 10 timed sequential runs, 60 s per-run
   timeout, 300 s whole-gate budget.

   Optional overrides: `?runs=10&warmups=2&runTimeoutMs=60000&budgetMs=300000`.
   Parsing is deliberately defensive, because a 0 ms watchdog once killed a real
   author run before the model had even loaded:

   - absent, blank (`?budgetMs=`), `0`, negative and non-numeric values all fall
     back to the defaults — a watchdog is never 0 ms;
   - values are clamped to sane ranges (`runs` ≤ 500, `runTimeoutMs` 1 s–10 min,
     `budgetMs` 30 s–1 h), and `budgetMs` is raised if it cannot contain one run;
   - `?budgetMs=off` (also `none`/`inf`) relaxes a watchdog to its 1 h ceiling
     rather than disabling it, so the page can still never hang forever;
   - `warmups=0` is honoured as a real request, but then the **first timed run
     absorbs shader compilation** and will usually blow the p95 ceiling. That is
     a true result, not a bug — use the default 2 warmups to measure steady state.

   Both the raw query params and the effective values land in the evidence JSON
   (`optionsRaw`, `options`, `optionNotes`), and the page header appends
   `· N option(s) defaulted/clamped` whenever any coercion happened.
4. Read the verdict, then eyeball the two previews (source left, normalized
   near-depth right, white = near). The plan requires a human sign-off that the
   layering is meaningful, not just numerically sane.
5. Click **Copy evidence JSON** and paste the result into the gate report.

### What the page asserts

Required checks (any failure ⇒ `FAIL`):

- model bytes and SHA-256 equal the audited candidate;
- graph exposes exactly `input.1` → `424`;
- `await ort.env.webgpu.device` resolves to a device;
- **every** run (warmups included) returns `location: 'gpu-buffer'` with a real
  `gpuBuffer`, `float32`, dims exactly `[1,1,128,160]`, buffer ≥ 81,920 bytes —
  this is the "no silent CPU fallback" proof;
- per fixture: readback yields 20,480 scalars, >99.9% finite and positive,
  `p95-p05 ≥ 0.5 m`, `std ≥ 0.15 m`, values within 0.05–15 m, mean neighbour
  gradient ≥ 0.005 m (not flat);
- sequential `p95 ≤ 5000 ms` (the plan's absolute ceiling);
- the gate finished without a fatal error or timeout.

Advisory checks (warn only, do not fail the gate): `p95 ≤ 2000 ms` (preferred
budget), agreement with the CPU-EP reference statistics, and the near/far probe
ordering.

Verdict surfaces: `document.title` = `DEPTH_GATE_PASS` / `DEPTH_GATE_FAIL`
(`DEPTH_GATE_RUNNING` while in flight), `document.documentElement.dataset.status`
= `PASS` / `FAIL` / `RUNNING`, and `window.__gateEvidence` (adapter info, ORT
version, model bytes/hash, per-run timings and output descriptors, value
statistics, stage timings, captured logs and errors).

### PASS vs FAIL

- **PASS** — badge is green, `0 required failure(s)`, `title = DEPTH_GATE_PASS`,
  and both previews show recognisable room geometry. Combined with the author's
  visual sign-off this clears Phase 0; the model, dims, preprocessing, semantics
  and range in `PROVENANCE.md` become the locked contract.
- **FAIL** — a required check is red, or the run hit its timeout budget (the page
  is designed to *always* produce a verdict rather than hang; abandoned runs are
  recorded in `evidence.errors` with `evidence.timedOut = true`). Follow the
  plan's branches: `p95` between 2 s and 5 s is an explicit "slow webcam" accept;
  `p95 > 5 s`, CPU-resident output, or degenerate values reject the candidate;
  visual inadequacy escalates to gating 192². Do not silently fall back to a
  heavier model.

### Local software-WebGPU result (not a substitute for the author's run)

On this host (Chrome + SwiftShader, no real GPU) the gate reports
`DEPTH_GATE_PASS`: 22 checks, 0 required failures, 1 advisory warning
(room-b's mean is 0.65 m off the CPU reference because Canvas2D resizing differs
from Lanczos). Every run — warmups included — came back GPU-resident float32
`[1,1,128,160]`, so ORT's WebGPU EP supports the whole graph with no operator
gaps and no CPU fallback. The first inference paid ~32 s of shader compilation;
afterwards p50 ≈ 7 ms, p95 ≈ 52 ms. Software timings say nothing about real-GPU
latency, and the plan's visual/licensing sign-off is still outstanding.
