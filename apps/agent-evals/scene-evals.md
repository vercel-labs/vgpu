# Scene evals

Three neutral two-turn tasks that observe whether a coding agent, starting from `npx vgpu`, can
build headless scene renderers with correct hierarchy transforms, custom-shader bindings, and
stable object identity. A fourth, explicit task, [`scene-math-interop`](#scene-math-interop),
asks the agent to render an existing entity system that already owns its matrices. A fifth task,
[`scene-quaternion-keyframes`](#scene-quaternion-keyframes), makes the public
vgpu skill available and observes which numerical source the agent picks for keyframed rotation.
The harness reruns the submitted source on inputs it chooses and grades the decoded output on the
host.

**It is not a benchmark.** A run is an observation of one agent on one branch. There are no
scores to compare across branches, no rankings, and no statistical claims. Scene-helper adoption,
tool choice, batching, and draw counts are recorded as observations and never gate a run.

Contract revisions are per task. The three neutral tasks use `scene-evals-v1`
(`SCENE_CONTRACT_REVISION` in `evals/lib/scene-contracts.mjs`); `scene-math-interop` uses its own
`scene-math-interop-v1`, `scene-quaternion-keyframes` uses `scene-quaternion-keyframes-v1`, and
`sceneContractRevision(taskId)` returns the right one. Adding the
interop task did not change any neutral prompt, seed, input, grader, or threshold. Adding the
quaternion task changed none of them either, nor anything of `scene-math-interop`. Any change to
case semantics or acceptance thresholds gets a new revision, and earlier results stay attached to
the revision that produced them.

## The tasks

| Task | Turn 1 (construction) | Turn 2 (follow-up) | Frames rerun after turn 2 |
| --- | --- | --- | --- |
| `scene-robot-arm` | Five-part arm; rest and shoulder poses | Parent translation/rotation plus independent elbow/wrist edits | `A, B, C, D, A` |
| `scene-shader-bindings` | Three boxes drawn with the supplied `integration.wgsl` | Absolute camera-position updates | `A, B, A` |
| `scene-warehouse` | 2,304 boxes, color pass and application-ID pass | Persistent delete/move/recolor by `appId` | four frames |

Each neutral task seed contains only `package.json`, `contract.md`, and — for the shader task —
`integration.wgsl`. The interop seed adds an `ecs/` directory; see
[its section](#scene-math-interop). The quaternion seed adds `example-input.json`; see
[its section](#scene-quaternion-keyframes). Seeds contain no renderer, no expected matrices or
images, no hidden inputs, no grader, and no reference-control source.

The construction prompt names `contract.md`, the `node render.mjs` entry point, and ends with
``Use `npx vgpu`.``. Robot and warehouse prompts and seeds name no scene function, import path,
documentation command, GPU plumbing, or strategy. The shader task deliberately supplies its WGSL
interface and requires the file unchanged: that is an integration condition, not a discovery
result. Stage-2 prompts live in `scene-contracts.mjs`. Warehouse operation semantics are
introduced there; the robot pose fields and shader camera convention are already in the
construction contracts.

A second-turn pass establishes correctness on that batch, not necessarily adaptation to a new
requirement. Run the preserved first-turn source against the second-turn inputs before making
an adaptation claim. The [pilot findings](scene-evals-findings.md) record these controls. A future
revision that measures adaptation should reserve a capability absent from the construction
contract and test that the first-turn implementation actually lacks it.

## Running it

Build and pack with Node 22, the repository's pinned version, then launch Eve with Node 24.
Packing builds the repository, so it must not run under the Node version Eve needs.

```bash
# Node 22: build the branch and pack it into .work/tarballs/
fnm exec --using=22 pnpm build
fnm exec --using=22 node apps/agent-evals/scripts/pack-vgpu.mjs --skip-build

# Node 24: one task per process, reusing the checked pack
fnm exec --using=24 node scripts/agent-evals.mjs --task scene-robot-arm --skip-pack \
  --max-concurrency 1 --timeout 1200000 --verbose
```

Run the three tasks serially, one process each. `VERCEL_OIDC_TOKEN` must already be in the
environment from the configured project; see [Model access](#model-access-project-oidc-only).

`--skip-pack` is consumed by the launcher and never forwarded to `eve eval`. Before Eve starts, it
reads `.work/tarballs/tarballs.json` (or `$VGPU_EVALS_TARBALLS_DIR/tarballs.json`), requires its
`sourceKey` to equal the current `sourceKey()` from `scripts/pack-vgpu.mjs`, and requires every
listed tarball to exist as a file beside the manifest. A missing, stale, or incomplete pack exits
with environment code **2**; nothing is rebuilt automatically. Without `--skip-pack` the launcher
packs as it always has.

### Local tests

The `node:test` files make no model calls, no network requests, and no GPU calls:

```bash
fnm exec --using=24 node --test apps/agent-evals/tests/*.test.mjs
fnm exec --using=24 pnpm --filter @vgpu/agent-evals exec tsc --noEmit
```

Root `pnpm test:fast` does **not** run them: `apps/agent-evals` is outside the root Vitest suite,
so run the command above explicitly.

| File | Covers |
| --- | --- |
| `tests/scene-math.test.mjs` | Host matrix composition, projection signs and depth, rotated masks, warehouse operations |
| `tests/grade-scene.test.mjs` | Grader boundaries on synthetic analytic images and state |
| `tests/scene-harness.test.mjs` | Turn/attempt paths, fresh-copy execution, timeouts, cleanup, seed contents |
| `tests/scene-auth.test.mjs` | OIDC guard, rejected API keys, `--skip-pack` consumption and manifest checks |
| `tests/scene-guidance.test.mjs` | [Docs guidance experiment](#docs-guidance-experiment-opt-in): selector and repetition parsing, pinned model/image, corpus restriction on synthetic and the real `a8a9bc8a`/`929b97f5` manifests, baseline tarball isolation and tamper rejection, lock normalization, unchanged default seeds, per-turn deviation records |
| `tests/scene-guidance-analysis.test.mjs` | Delivered guide content versus discovery, per-turn exposure, truncation, event deduplication, usage totals, and possible contamination |
| `tests/scene-interop.test.mjs` | Neutral contracts and seeds still match the frozen hashes in `tests/fixtures/scene-neutral-v1.json`; the interop revision, inputs, and prompts; fixture invariants, and state/pixel gates rejecting isolated faults on synthetic output; native control stages and expected frames; the seed ECS's stable buffers, parent propagation, and generational row reuse; the oracle reproducing the contract example; the ECS agreeing with the oracle over both turn inputs |
| `tests/scene-keyframes.test.mjs` | The [quaternion task](#scene-quaternion-keyframes): oracle against the contract example and an independent closed form, sign invariance and clamping; frozen fixture hashes and geometric invariants; the grader accepting a synthetic disc rendering; a three-file seed and prompts that name no package, technique, or API; dispatch with every neutral contract and seed hash unchanged; the guidance selector rejected with exit 2 before auth or packing; the skill resolver returning `null` for other task IDs; scene-reference hash validation and advertisement rejecting missing or changed sibling files |

Synthetic images validate grader logic only. They are not native controls.

### Native controls

The control runner executes a real reference implementation and deliberately broken variants
through the host `executeFreshSource` rerun and the production grader, with no model and no judge:

```bash
fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs --task scene-robot-arm --backend host

# Linux/Mesa in the pinned Eve image
export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs --task scene-robot-arm --backend docker
```

`--task` is required and takes exactly one scene task ID; there is no "all tasks" expansion.
`--backend` is `host` (default) or `docker`; any other value is rejected. One invocation runs the
positive reference at both stages, then every broken control for that task, sequentially.

| Exit | Meaning |
| --- | --- |
| `0` | Every positive passed and every broken control was rejected by its intended class of output check |
| `1` | An unexpected control result |
| `2` | Missing or stale pack, native setup failure, or another infrastructure error |

Each run writes a fresh `.work/scene-controls/<timestamp>-<unique-id>/<task>/` with `summary.json`
(positive and negative verdicts, metric distributions) plus raw source, inputs, outputs, and logs.
A prior calibration is never overwritten. The underlying exit status and reason are preserved in
every case.

| Task | Broken control | Expected rejection |
| --- | --- | --- |
| Robot | Reverse joint multiplication order | Matrix and/or projected geometry on a noncommuting pose |
| Robot | Parent movement not propagated to descendants | Descendant matrices/locations at frame C |
| Robot | Correct CPU matrices, frozen rendered frame | Pixel/tip checks after A; numeric checks still pass |
| Shader | CPU camera recomputed, uniform never uploaded | Matrix/origin checks pass; B image position fails |
| Shader | Previous frame's camera uploaded | A–B–A image checks expose the lag |
| Shader | `gain=1, floor=0` instead of the supplied style | Geometry passes; interior color fails |
| Warehouse | Packed slot used as application identity | Update/remove targets or reported IDs after compaction |
| Warehouse | Initial instance count kept | Deleted/extra geometry or count |
| Warehouse | CPU items updated, no publication after move/recolor | Inventory passes; GPU centers/colors/IDs fail |
| Warehouse | Instance indices encoded as IDs | Complete ID set and per-item IDs |
| Warehouse | Deleted boxes retained | Deleted-cell, ID-set, and count checks |

A broken control must initialize native rendering and produce valid artifacts; a syntax or setup
error is not a useful negative. `summary.json` records which checks rejected each fault, not just
that something failed. These controls validate the executable protocol, fresh-source executor,
native output, and grader; they do not pass through Eve's live sandbox hook. The standalone
harness regressions exercise that hook transport with a faithful fake whose commands return real
exit codes, including failed source copy, manifest, evidence export, and cleanup. Paid pilots are
the end-to-end check of the real Eve transport, exact event correlation, cleanup marker, driver,
and grader together.

## Docs guidance experiment (opt-in)

`VGPU_EVALS_SCENE_GUIDANCE` runs a scene task as one arm of a docs-only comparison: the agent gets
the same runtime and the same pinned `math@0.1.0` in both arms, and only the `vgpu docs` corpus
differs. Leave it unset for ordinary runs — unset or empty changes nothing about packing, seeds,
installs, prompts, or grading.

| Value | Installed `vgpu docs` corpus |
| --- | --- |
| `baseline` | The generated docs manifest from `a8a9bc8a`, before the scene-math guide |
| `math` | The generated docs manifest from `929b97f5`: adds `/guides/scene-math.docs.md` and the "Scope and external math" content in `/guides/scene-composition.docs.md` |

Any other value (including `BASELINE`) exits with environment code **2** before anything is
packed or started, and so does setting it for a non-scene task. `scene-math-interop` does not
take part: its eval definition throws when a variant is set, before any case runs.
`scene-quaternion-keyframes` does not take part either: its eval definition throws the same way,
and the launcher exits **2** before the OIDC guard or packing. Contracts,
prompts, seeds, graders, and thresholds are the `scene-evals-v1` ones in both arms. Experiment runs
install `math` and default neutral-task runs do not, so never pool the two.

### Launch an arm

Pack exactly as for a default run, then launch each arm in its own process with the fixed model
and the pinned image:

```bash
fnm exec --using=22 pnpm build
fnm exec --using=22 node apps/agent-evals/scripts/pack-vgpu.mjs --skip-build

export VGPU_EVALS_MODEL=anthropic/claude-sonnet-5
export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
VGPU_EVALS_SCENE_GUIDANCE=baseline fnm exec --using=24 node scripts/agent-evals.mjs \
  --task scene-robot-arm --skip-pack --max-concurrency 1 --timeout 1200000 --verbose
```

Experiment mode refuses to start unless `VGPU_EVALS_MODEL` is exactly `anthropic/claude-sonnet-5`
and `VGPU_EVALS_DOCKER_IMAGE` is exactly that digest; the unset defaults do not count. The check
runs after the [OIDC guard](#model-access-project-oidc-only), exits **2**, and nothing is packed,
fetched, or started. Because `VGPU_EVALS_MODEL` is set, the launcher's 16-token model preflight
also runs.

`VGPU_EVALS_SCENE_REPETITIONS=2` makes the task's eval file export two cases instead of one. Eve
names dataset entries by file plus index (`scene-robot-arm/0000`, `scene-robot-arm/0001`), and
`--task` still selects both. Each case is a fresh session from the same cached template, and
`scene-run.json` records `repetition` as `1` or `2`. Unset or `1` keeps the original single
eval; an empty string or any other value exits **2**. It applies to scene tasks only, with or without
`VGPU_EVALS_SCENE_GUIDANCE`. The frozen 12-slot comparison leaves it unset: each slot is one
standalone Eve invocation, and the lead-owned ledger records the outer repetition.

The completed September 29 comparison is recorded in
[findings](scene-math-evals-findings.md) and [machine-readable results](scene-math-evals-results.json).

The arm label stays on the host. The launcher deletes `VGPU_EVALS_SCENE_GUIDANCE` from its
environment before it spawns Eve, and selects the arm only by pointing `VGPU_EVALS_TARBALLS_DIR` at
that arm's prepared directory. Tarball file names are identical in both arms, so the sandbox sees
the same `/workspace/.vgpu-tarballs/vgpu-0.5.0.tgz` either way.

### Prepared tarball pairs

The launcher builds both arms from the checked pack before Eve starts, after the usual
[`--skip-pack` staleness check](#running-it). You can also prepare or revalidate the pair by hand;
the command prints the path of its `scene-guidance.json`:

```bash
fnm exec --using=24 node apps/agent-evals/scripts/scene-guidance.mjs \
  [--tarballs <pack-dir>] [--out <fixtures-dir>]   # defaults: .work/tarballs, .work/scene-guidance
```

Preparation fails, and the launcher exits **2** with `scene guidance preparation failed`, unless
all of these hold:

- the source pack's `sourceKey` equals the current `sourceKey()`;
- the packed vgpu tarball's `package/dist/cli/lib/generated/docs-manifest.generated.js` is
  byte-identical to `packages/vgpu/lib/generated/docs-manifest.generated.js` at `929b97f5`;
- compared with the same file at `a8a9bc8a`, everything outside `records` is identical, exactly one
  record is added (`/guides/scene-math.docs.md`, symbol `scene-math`, repo path
  `docs/topics/scene-math.docs.md`), none is removed, and exactly one changes
  (`/guides/scene-composition.docs.md`), in its `content` field only. Records are keyed by virtual
  path plus anchor (or symbol when there is no anchor).

Both arms get byte-for-byte copies of every tarball. For `baseline` only, the vgpu tarball is
extracted, that one manifest is replaced with the `a8a9bc8a` bytes, and the tree is re-archived
with `tar` — not `npm pack`, whose `prepack` regenerates the docs. The result is extracted again
and must differ from the packed tree in that one path only, comparing file contents, modes, and symlinks.
Every file in it is then scanned for treatment markers (`/guides/scene-math.docs.md`,
`docs/topics/scene-math.docs.md`, `# Using math with scene data`, `math@0.1.0`); any hit fails.

The pair lands in `.work/scene-guidance/scene-math-guidance-v1-<sourceKey>-<baseline12>-<math12>/`,
named from the source key and the first 12 hex digits of each corpus hash:

| Path | Contents |
| --- | --- |
| `scene-guidance.json` | Experiment, `sourceKey`, `runtimeGitSha`, `baselineGitSha`, `currentDocsGitSha`, dependency, record comparison, per-arm corpus and vgpu tarball hashes |
| `baseline/tarballs/`, `math/tarballs/` | The six tarballs plus a `tarballs.json` that adds a `sha256` to every entry and a `sceneGuidance` block |
| `corpora/baseline-docs-manifest.generated.js`, `corpora/math-docs-manifest.generated.js` | Both corpora's exact bytes |

`sceneGuidance` carries `experiment`, `variant`, `baselineGitSha`, `currentDocsGitSha`,
`runtimeGitSha`, `docsManifestPath`, `docsSha256`, `counterpartDocsSha256`, `dependency`,
`comparison`, and `sourceTarballsManifestSha256`. `sourceKey` is unchanged: both arms run the same
runtime tree.

A fixture directory is written once — built in a staging directory, then renamed into place.
When it already exists, the launcher revalidates it instead of rebuilding: identity and corpus
hashes in `scene-guidance.json`, each arm's label and `math@0.1.0` identity, every tarball's
SHA-256, and the docs manifest hash read back out of the vgpu tarball. A mismatch fails as a tamper
or stale artifact and is never repaired in place; delete that directory to rebuild it. A new pack
or a different corpus gets a new directory.

### Template cache per corpus

The sandbox revalidation key is `vgpu-<sourceKey>-<docsSha256>-<taskId>-<seedHash>`, using the
arm's corpus hash, not its name. The two arms never share a cached template; repetitions of one
arm do. Default runs put `default-corpus` in that position.

### Bootstrap corpus and math checks

In experiment mode only, bootstrap adds `math@0.1.0` to the same `npm install` as the tarballs and
`pngjs`. After both installs and before `vgpu doctor` — so before any model turn — it fails the
template as an infrastructure error unless:

- exactly one `*/dist/cli/lib/generated/docs-manifest.generated.js` exists under `node_modules`;
- that file's SHA-256 equals the arm's `docsSha256`;
- `node_modules/math/package.json` and the lock's `node_modules/math` entry are both `0.1.0`, and
  the locked integrity equals the pinned `sha512-hq5K…` (`SCENE_EXPERIMENT_MATH_INTEGRITY`).

It then writes `.work/template-provenance/<taskId>-<docsSha256>.json`: arm, `sourceKey`, template
key, expected and installed docs hashes, installed manifest paths, `vgpu` and `math` versions, math
integrity, a SHA-256 of `package-lock.json` with the vgpu entry's `resolved`/`integrity` normalized
(equal across arms when only the corpus differs), a SHA-256 of `npm ls --all --json`, model, image,
and sandbox Node. Bootstrap runs once per template, so this file describes the cached build. The
eval rereads it every time it writes `scene-run.json` and stores it as `templateProvenance`, or
`{ "unavailable": true }` when it is missing; outside experiment mode the field is `null`.

### Per-turn provenance and deviations

Before archiving each turn, the `turn.completed` hook reads the installed state again and stores it
as `sceneGuidance` in that attempt's `complete.json`, which `scene-run.json` keeps under each turn's
`complete`:

- `condition`, and `expected` `docsSha256`, `vgpuVersion`, `mathVersion` from the arm's manifest;
- `observed` `docsSha256`, `docsManifestPaths`, `vgpuVersion`, `mathVersion`;
- `protocolDeviation`, plus `observationError` when the read itself failed.

`protocolDeviation` is `true` when there is not exactly one installed docs manifest, its hash
differs from the arm's, or the installed `vgpu` or `math` version differs — for example after the
agent installs `vgpu@latest`. It is observational: it never changes a
gate, a classification, or the run outcome, and the run is kept. Outside experiment mode it is
`null`.

The run-level record adds `repetition`, the arm's `sceneGuidance` block, and `templateProvenance`.
Source hints add `mentionsMathImport`, a regex over source text for a `"math"` or `'math'` string in
every mode; like the other hints, it is not evidence that the package executed.

These records prove which corpus was installed at bootstrap and at the end of each turn. They do not
show a swap and restore inside one turn, and they do not show what the agent read: installed docs
are available, not consumed.

Analyze a saved Eve transcript with:

```bash
node apps/agent-evals/scripts/analyze-scene-guidance.mjs events.ndjson baseline analysis.json
```

Use `math` for the guidance arm. This reports usage, tool counts, and guide markers in returned
tool content, including the turn and step where content first appeared. A title or slug alone
counts as surfaced; registered section headings count as content delivered. Neither proves
understanding. Baseline surfaced-only matches are possible contamination requiring transcript
review. Inspect archived source to determine whether imported math or scene helpers actually run.

## The executable contract

Every submission exposes exactly this command:

```sh
node render.mjs /absolute/input.json /absolute/output-directory
```

The output directory is fresh and empty for every invocation. The program reads all frames,
processes them in order in one process, writes `result.json` and its PNGs into the output
directory, disposes GPU resources, and exits. No server, no browser.

```ts illustrative
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

type RobotFrame = {
  basePosition: Vec3;
  baseAngle: number;
  shoulderAngle: number;
  elbowAngle: number;
  wristAngle: number;
};
type ShaderFrame = { cameraPosition: Vec3 };
type WarehouseItem = { appId: number; position: Vec3; tint: Vec4 };
type WarehouseOperation =
  | { op: "delete"; appId: number }
  | { op: "move"; appId: number; position: Vec3 }
  | { op: "recolor"; appId: number; tint: Vec4 };
type WarehouseFrame = { operations: WarehouseOperation[] };

type Batch<F> = { version: 1; requestId: string; frames: F[] };
type RobotInput = Batch<RobotFrame>;
type ShaderInput = Batch<ShaderFrame>;
type WarehouseInput = Batch<WarehouseFrame> & { items: WarehouseItem[] };

type RobotState = {
  joints: { base: number[]; shoulder: number[]; elbow: number[]; wrist: number[]; tip: number[] };
}; // each matrix: 16 finite column-major numbers, without mesh center/size
type ShaderState = {
  viewProjection: number[]; // 16 finite column-major numbers
  origins: { left: Vec3; right: Vec3; upper: Vec3 };
};
type WarehouseState = { count: number; items: WarehouseItem[] }; // sorted by appId

type BatchOutput<S> = {
  version: 1;
  requestId: string;
  frames: { index: number; color: string; ids?: string; state: S }[];
};
```

- `version`, `requestId`, and the frame count must match the input. Frame `index` values are
  zero-based and in order.
- `color` and `ids` are relative file paths below the output directory. `000-color.png` and
  `000-ids.png` are canonical examples; filenames are not graded. An absolute path or one that
  escapes the directory fails the output contract, and the grader never reads it.
- `ids` is required on every warehouse frame and absent elsewhere.
- PNGs must decode at exactly the task's size with RGBA bytes. Missing, corrupt, and wrong-size
  files fail. Numeric state must be finite and have the documented lengths.
- Every harness input is valid. Agents are not asked to handle malformed input.

All images use offscreen `rgba8unorm`, alpha 255, an opaque black clear, a depth attachment, and
no MSAA, blending, lighting, tone mapping, or rescaling. PNG rows use the normal top-left origin.
Geometry is boxes; colors are exact primary/secondary RGB values. These requirements live in each
seed's `contract.md`, never in the neutral agent instructions.

Transforms use column vectors and column-major matrices. The camera for every task has identity
orientation and orthographic projection with WebGPU depth (`[0, 1]`). A world point projects to
pixel `x = W * (ndcX + 1) / 2`, `y = H * (1 - ndcY) / 2`.

## scene-robot-arm

512×384. Camera position `[0,0,8]`, orthographic `left=-4, right=4, bottom=-3, top=3, near=0.1,
far=20`. Angles are absolute radians about +Z:

```text
base     = T(basePosition) Rz(baseAngle)
shoulder = base T(0,0.35,0) Rz(shoulderAngle)
elbow    = shoulder T(1.5,0,0) Rz(elbowAngle)
wrist    = elbow T(1.1,0,0) Rz(wristAngle)
tip      = wrist T(0.5,0,0)
```

Mesh size and center are separate from the joint transforms:

| Part | Joint | Local center | Dimensions | RGB |
| --- | --- | --- | --- | --- |
| Base | base | `[0,0,0]` | `[0.6,0.5,0.3]` | yellow |
| Upper arm | shoulder | `[0.75,0,0]` | `[1.5,0.22,0.25]` | red |
| Forearm | elbow | `[0.55,0,0]` | `[1.1,0.18,0.2]` | green |
| Tool | wrist | `[0.25,0,0]` | `[0.5,0.24,0.2]` | blue |
| Tip marker | tip | `[0,0,0.2]` | `[0.12,0.12,0.12]` | magenta |

| Frame | `basePosition` | `baseAngle` | `shoulderAngle` | `elbowAngle` | `wristAngle` |
| --- | --- | --- | --- | --- | --- |
| A rest | `[-1.8,-0.7,0]` | 0 | 0 | 0 | 0 |
| B shoulder | `[-1.8,-0.7,0]` | 0 | 0.6 | 0 | 0 |
| C parent | `[-1.4,-0.2,0]` | 0.35 | 0.6 | 0 | 0 |
| D articulated | `[-1.4,-0.2,0]` | 0.35 | 0.6 | -0.85 | 0.25 |
| A return | `[-1.8,-0.7,0]` | 0 | 0 | 0 | 0 |

Turn 1 asks for rest and shoulder posing and reruns `[A, B]`. The follow-up asks for base
translation/rotation and independent elbow/wrist edits while keeping earlier behavior, and reruns
`[A, B, C, D, A]`. Every pose field is an absolute replacement, so the returning A must satisfy
A's expectations independently.

Minimal input and output shape (zero pose, one frame):

```json
{ "version": 1, "requestId": "example", "frames": [
  { "basePosition": [0, 0, 0], "baseAngle": 0, "shoulderAngle": 0, "elbowAngle": 0, "wristAngle": 0 }
] }
```

```json
{ "version": 1, "requestId": "example", "frames": [
  { "index": 0, "color": "000-color.png", "state": { "joints": {
    "base":     [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
    "shoulder": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0.35,0,1],
    "elbow":    [1,0,0,0, 0,1,0,0, 0,0,1,0, 1.5,0.35,0,1],
    "wrist":    [1,0,0,0, 0,1,0,0, 0,0,1,0, 2.6,0.35,0,1],
    "tip":      [1,0,0,0, 0,1,0,0, 0,0,1,0, 3.1,0.35,0,1]
  } } }
] }
```

Nodes, flat hierarchy arrays, and application-owned matrix composition all pass. The transform
path used is recorded separately from correctness.

## scene-shader-bindings

Same size, camera, and projection as the robot. Three axis-aligned boxes of side 0.6:
`left=[-1.5,-0.6,0]` red, `right=[1.3,-0.4,0]` green, `upper=[-0.1,1,0]` blue.

`integration.wgsl` is supplied verbatim: `style` at group 0 / binding 0, `viewState` at group 1 /
binding 0, world matrix columns at vertex locations 2–5, tint at location 6, entry points `vs_main`
and `fs_main`, no imports. The program loads it at runtime, keeps its bytes unchanged, and binds
`style` with `gain=0.75, floor=0.125`. Interior colors are therefore 223 in tint channels of one
and 32 in tint channels of zero.

Turn 1 reruns camera A `[0,0,8]`. The follow-up asks for camera translation with fixed identity
orientation — no retargeting toward the origin — and unchanged object origins, and reruns
`[A, B, A]` with B `[0.8,0.45,8]` in one invocation. Camera position is an absolute replacement.
In frame B every rectangle moves 51.2 px left and 28.8 px down.

```json
{ "version": 1, "requestId": "example", "frames": [ { "cameraPosition": [0, 0, 8] } ] }
```

```json
{ "version": 1, "requestId": "example", "frames": [
  { "index": 0, "color": "000-color.png", "state": {
    "viewProjection": [0.25,0,0,0, 0,0.3333333333,0,0, 0,0,-0.0502512563,0, 0,0,0.3969849246,1],
    "origins": { "left": [-1.5, -0.6, 0], "right": [1.3, -0.4, 0], "upper": [-0.1, 1, 0] }
  } }
] }
```

The camera matrix may come from scene functions or application-owned math. What matters is that
the uploaded binding changes: uniform values are copied, so recomputing a CPU matrix without
refreshing the draw's `viewState` binding leaves the image unchanged and fails the B frame.

## scene-warehouse

576×576. Camera position `[0,0,8]`, orthographic bounds `[-24,24]` on x and y, near 0.1, far 20.
2,304 axis-aligned side-0.6 boxes. For initial index `i = 0..2303`:

```text
appId    = 10001 + 17 * i
row      = floor(i / 48)
column   = i % 48
position = [column - 23.5, 23.5 - row, 0]
tint     = [red, green, blue, cyan, magenta, yellow][i % 6]   (alpha 1)
```

The full item array is always in the input; agents never infer IDs from slots.

Turn 1 reruns frame 1 only. The follow-up discloses sequential, persistent operations addressed by
stable `appId`, and reruns all four frames:

| Frame | Operations | Live items |
| --- | --- | --- |
| 1 | none | 2304 |
| 2 | delete `10290` | 2303 |
| 3 | move `49152` to `[-6.5,23.5,0]`; recolor it cyan | 2303 |
| 4 | delete `26950`; move `49135` to `[13.5,3.5,0]`; recolor it blue; recolor `49152` magenta | 2302 |

The ID pass writes `[id & 255, (id >> 8) & 255, (id >> 16) & 255, 255]` with background
`[0,0,0,255]`. Color and ID passes use the same current geometry and state.

```json
{ "version": 1, "requestId": "example",
  "items": [ { "appId": 10001, "position": [-23.5, 23.5, 0], "tint": [1, 0, 0, 1] } ],
  "frames": [ { "operations": [] } ] }
```

```json
{ "version": 1, "requestId": "example", "frames": [
  { "index": 0, "color": "000-color.png", "ids": "000-ids.png", "state": {
    "count": 1,
    "items": [ { "appId": 10001, "position": [-23.5, 23.5, 0], "tint": [1, 0, 0, 1] } ]
  } }
] }
```

App-owned maps, reordered packing, several instance batches, and rebuilt instance streams all
pass. There is no performance gate and no fixed draw-count gate.

## scene-math-interop

An explicit functional-usability task: can an agent that is told to render an existing entity
system (ECS) — one that already owns its matrices through `math@0.1.0` — connect those matrices to
vgpu correctly? It checks that mesh transforms are composed in the right owner, camera uniforms are
published explicitly, mutation and hierarchy reach the GPU, and the renderer handles lifecycle
commands introduced in turn 2. The completed pilot has
[findings](scene-math-interop-findings.md) and [results](scene-math-interop-results.json).

It does **not** measure spontaneous adoption of `math` (the neutral tasks cover that), whether
guidance helps, or model rankings. The prompt names the dependency and the guide on purpose, so
this does not measure unaided discovery. Tool-use detours can still be recorded as observations;
no causal comparison with the earlier neutral or guidance trials is drawn from them.

| Field | Value |
| --- | --- |
| Task ID | `scene-math-interop` |
| Contract revision | `scene-math-interop-v1` |
| Turns | Two, in one session |
| Image | 512×384, orthographic camera, WebGPU `[0, 1]` depth |
| Instructions | The neutral `agent/instructions.md` |
| Budgets | The same as the neutral tasks: 60 s per rerun, 20 minutes per task run |

Contract, prompts, inputs, and the oracle live in `evals/lib/scene-interop.mjs`, which is the
authority for every value below.

### Seed

| File | Content |
| --- | --- |
| `package.json` | Private module that depends on `math` `0.1.0` |
| `contract.md` | The executable contract with a full example input and output; no turn-2 schema |
| `ecs/world.mjs` | The frozen ECS. The agent must leave it byte-identical |
| `ecs/README.md` | ECS usage only. It names no vgpu API and no rendering approach |

The ECS exposes `createWorld({ capacity = 64 })` with `spawn`, `setPosition`, `setRotation`,
`setScale`, `setParent` (keeps the local transform), `despawn` (cascades to descendants), `isAlive`,
`rowOf`, `parentOf`, `renderable`, `camera`, `entities` (live handles in row order), and `update`
(returns the rows whose world matrix it recomputed). It owns `T·R·S` locals and
`world = parentWorld · local` in `localMatrices` and `worldMatrices` — `Float32Array`s allocated
once, row `r` at `[16r, 16r + 16)` — plus a `Uint32Array` `worldVersion`. Handles are generational
(generation in the upper bits, row in the lower 16), and freed rows are reused, so a later entity
can occupy a row an earlier one held. Renderable `size`, `offset`, and `color` are never part of a
matrix.

The seed's dependency installs `math@0.1.0`. For this task, bootstrap checks the installed and
locked version and the lock's integrity against the pinned `SCENE_EXPERIMENT_MATH_INTEGRITY` in
every mode, not only in the guidance experiment; a mismatch is an infrastructure error. Seed
copying includes the `ecs/` subdirectory.

### Prompts

Turn 1 asks for the renderer described in `contract.md`, with the `node render.mjs` entry point.
It states that the ECS owns every transform and that `ecs/` stays unchanged, and that the
application uses the installed `math@0.1.0` for numerical operations. It asks the agent to use
`math` for camera projection and inversion and for mesh-matrix composition while consuming the ECS
world matrices. It explicitly requests `instances` and `instanceGeometry` with GPU publication,
allows reading the bundled `/guides/scene-math.docs.md` examples, says every input
uses only `set` commands, and ends with ``Use `npx vgpu`.``.

Turn 2 discloses the complete new schema — `spawn`, cascading `despawn`, and `parent` (keeps the
local transform) — with spawn-key allocation, a camera that may gain a parent, and "keep every
earlier behavior working". Nothing is held back from either turn.

### Fixture

Keys are array positions in `entities`. Quaternions rotate about +Z. Both turns share the same nine
entities:

| Key | Parent | Role |
| ---: | --- | --- |
| 0 | — | Camera at `[0,0,10]`, bounds x −4..4, y −3..3, near 0.1, far 20 |
| 1 | — | Red box with nonuniform scale `[1.6,0.8,1]` |
| 2 | 1 | Green child rotated 30°, with a mesh offset; sheared by its parent's scale |
| 3 | 2 | Blue grandchild rotated −45°, in front of key 2 |
| 4 | — | Yellow box at z 4, nearest the camera; with `[-1, 1]` depth it and most of the scene are clipped |
| 5, 6 | — | Overlap pair A (magenta front, cyan back), lower key in front |
| 7, 8 | — | Overlap pair B (orange back, violet front), lower key behind |

The pairs are drawn in opposite key orders, so any fixed draw order without a depth test fails one
of them.

| Turn | Frame | Commands |
| --- | --- | --- |
| 1 | F0 | None |
| 1 | F1 | Move and rotate key 1; keys 2 and 3 must follow |
| 1 | F2 | Scale key 2, so key 3 follows; move the camera |
| 1 | F3 | Restore every earlier value; the expected output equals F0 |
| 2 | G0 | None |
| 2 | G1 | Spawn a camera rig (key 9), parent the camera to it, move and rotate the rig 6°, despawn key 3 |
| 2 | G2 | Spawn key 10 under key 2 (reuses key 3's row), despawn key 4, rotate the rig −6° |
| 2 | G3 | Reparent key 5 to the rig, despawn key 1 (cascades to 2 and 10), spawn key 11 into a reused row |

A deterministic test asserts the fixture invariants for every frame before the harness is frozen:
every silhouette at least 8 px inside the image with at least 400 interior pixels, designed
overlaps at least 24×24 px with front faces at least 0.5 apart in z, rigid camera worlds, and
world matrices that keep each front face at constant depth.

### Grading

The oracle in `evals/lib/scene-interop.mjs` is independent of the submission's code: it imports no
`math` and no ECS, keeps its own entity table keyed by input key, and uses scalar matrix code. It
allocates spawn keys, cascades despawns, keeps the local transform on reparent, computes
`world = parentWorld · T·R·S` recursively, inverts the rigid camera by transpose, and projects each
box's front face through `viewProjection · world · T(offset) · S(size)`. The frontmost silhouette
wins each pixel. A broken fixture invariant is an infrastructure error.

Every gate is hard, on every turn and every frame. A turn passes only when all pass; a session
passes only when both turns pass.

| Gate | Passes when | Does not prove |
| --- | --- | --- |
| `source-execution` | The fresh copy exits 0 within 60 s | Correctness |
| `protocol` | Version, `requestId`, frame count, `index` equal to array position; the exact live key set in sorted order; 16 finite numbers per matrix | — |
| `artifacts` | PNGs are relative files below the output directory and decode at 512×384 | — |
| `ecs-unmodified` | `ecs/world.mjs` and `ecs/README.md` SHA-256 values from the rerun evidence match the seed | Absence of runtime patching |
| `interop-state` | Every `world` and `viewProjection` is within `1e-4` of the oracle | That the values came from the ECS or reached the GPU |
| `interop-pixels` | Per renderable, ≥ 98% of the frontmost interior, eroded by 2 px, matches its RGB within ±2; ≥ 99% of non-black pixels lie inside the union of silhouettes dilated by 2 px | Which library computed the values |

State and pixels are graded separately against the oracle, so correct reported matrices over a
stale image fail, and so does the reverse. Outcomes stay `pass`, `application-failure`, and
`infrastructure-error`. `scene-run.json` also records `clarificationRequested` when the agent asks
a question; the driver sends turn 2 regardless.

### Math-use conformance and ownership

Conformance to the `math` instruction is reviewed separately from the gates and never replaces
them. After the pilot, a blinded source review with labels removed classifies each final solution:
external `math` for camera projection, for the camera inverse, and for mesh composition; vgpu
helpers; handwritten kernels; or none. Calls the seeded ECS makes do not count; the review
separates them from `math` calls the agent wrote. A numerically correct renderer that ignores the
instruction has correct output but lacks integration conformance. `mentionsMathImport` and the
other source hints stay regex observations, and there is no import-regex gate.
The same review verifies use of the requested instance collection and GPU publication bridge on
the render path. Correct pixels alone do not establish conformance to those instructions.

This revision has no ownership probe and no runtime call tracing. Whether the renderer draws from
the ECS's matrices or recomputes them is judged from independent code review plus the executed
output, and is never reported as runtime attestation.

### Native controls

```bash
fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs --task scene-math-interop --backend host

export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs --task scene-math-interop --backend docker
```

The reference drives the seed ECS, draws each renderable with `ecsWorld · T(offset) · S(size)`
using `math`, inverts the camera world, uploads `viewProjection` every frame, publishes every
frame, and renders with depth. Staging copies `ecs/` beside it, and the host backend installs
`math@0.1.0`. Every broken control must render valid output; the runner checks that the named gate
rejects it and that the listed gates still pass.

| Control | Turn | Must reject | Must still pass |
| --- | --- | --- | --- |
| Reference | 1, 2 | — | All gates |
| Reverse mesh order (`T·S·world`) | 1 | Pixels | State |
| Double parent (`parentWorld · world` for children) | 1 | Pixels | State |
| Shear loss (decompose and recompose the world) | 1 | Pixels | State |
| `[-1, 1]` depth instead of `[0, 1]` | 1 | State and pixels | — |
| Stale camera (projection computed once; state reports it fresh) | 1 | Pixels | State |
| Descendant update omitted (uploads only rows named by `set`) | 1 | Pixels | State |
| Missed publish after F0 | 1 | Pixels | State |
| Turn-1-only renderer (rejects non-`set` commands) | 2 | Source execution | — |
| Key used as ECS row | 2 | State and pixels | — |
| Orphan instances (despawn keeps them) | 2 | Pixels | State |
| Camera from its local transform | 2 | State and pixels | — |
| Instance count cached from the first frame | 2 | Pixels | State |

The turn-1-only control shows that turn 2 needs real adaptation. Extra positive renderers, a
no-depth control, and a mesh-size-in-ECS control are not part of this revision. As for the neutral
tasks, controls validate the protocol, executor, native output, and grader on one environment and
attest nothing about a submission.

### Running the pilot

The pilot is lead-owned and starts only after the local tests and native controls pass. The lead
freezes the harness, then runs two fresh sessions serially, two turns each, with
`anthropic/claude-sonnet-5` through the project OIDC token and the pinned image:

```bash
fnm exec --using=22 pnpm build
fnm exec --using=22 node apps/agent-evals/scripts/pack-vgpu.mjs --skip-build

export VGPU_EVALS_MODEL=anthropic/claude-sonnet-5
export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
fnm exec --using=24 node scripts/agent-evals.mjs --task scene-math-interop --skip-pack \
  --max-concurrency 1 --timeout 1200000 --verbose
```

`VERCEL_OIDC_TOKEN` must already be in the environment, and the
[OIDC guard](#model-access-project-oidc-only) applies unchanged. Every attempt is retained, and an
application failure is never retried. An infrastructure or auth failure is recorded separately and
may be rerun under a new slot number. Each run records the Eve version, tarball hashes, the `math`
lock integrity, the seed hash, and each turn's input SHA-256.

Each run reports per-turn gates, the math-use category, carry-forward, clarifications, steps, and
cost, as counts with no rates or rankings. For carry-forward, the lead reruns each session's
turn-1 source on the turn-2 input where the control executor supports it cheaply. It is
diagnostic only and never changes a grade: adaptation is claimed only when that rerun fails and
turn 2 passes. Without it, the report compares sources and makes no adaptation claim.

### Limitations

- The trust model is non-adversarial. `ecs-unmodified` does not stop runtime patching, and there
  is no runtime attestation of which code produced a matrix.
- Two sessions are a pilot. They cannot separate a model effect from API usability, and no rate
  is generalized from them.
- Mesa llvmpipe gives functional results only: no hardware-GPU or performance evidence.
- Rotations are about Z only and the camera is orthographic, chosen for pixel stability. 3D
  rotations and perspective are not exercised.
- The prompt names `math` and its guide, so the task says nothing about discovery or spontaneous
  adoption.

## scene-quaternion-keyframes

The completed pilot has [findings](scene-math-discovery-findings.md) and
[portable results](scene-math-discovery-results.json). The report separates the two eligible
sessions from an earlier retained harness bookkeeping failure.

A package-choice task. The agent builds a keyframed-rotation renderer whose
interpolation vgpu does not provide — vgpu has no quaternion interpolation, and `composeMatrix`
only normalizes — with the public vgpu skill available. The run observes whether the output is
correct on each turn, and which numerical source the agent picks: `math`, a library that is
already installed, another package, or a handwritten kernel.

Correctness is graded independently of that choice. Library choice is an observation: it is never
a gate, never rewarded, and a correct handwritten or `wgpu-matrix` implementation passes exactly
like a `math` one. The prompts and seed name no package, technique, or API; the semantic
requirements (fixed axis, constant angular speed, smaller angle) are all in the contract.

This is one arm with the skill available. It does **not** measure unaided discovery, because the
skill can route the agent to its answer. It is not an A/B estimate: there is no no-skill arm, so
no causal skill effect, rate, model ranking, or verdict on package quality can come from it. A
comparison arm — the same task with the skill withheld and several sessions per arm — needs a new
lead decision.

| Field | Value |
| --- | --- |
| Task ID | `scene-quaternion-keyframes` |
| Contract revision | `scene-quaternion-keyframes-v1` |
| Turns | Two, in one session |
| Image | 512×384, orthographic camera, WebGPU `[0, 1]` depth |
| Instructions | The neutral `agent/instructions.md`, unchanged |
| Skill | The public `skills/vgpu/SKILL.md` and authored `scene.md`, for this task only |
| Budgets | The same as the neutral tasks: 60 s per rerun, 20 minutes per task run |

Contract, prompts, inputs, the oracle, and the grader live in `evals/lib/scene-keyframes.mjs`,
which is the authority for every value below.

### Seed

| File | Content |
| --- | --- |
| `package.json` | `{"private":true,"type":"module"}` — no dependencies |
| `contract.md` | The executable contract, schema and semantics only |
| `example-input.json` | Two identity keyframes and one frame at `t = 0`; the contract gives its output, `world` equal to identity |

There is no lock file and no source. A test rejects `slerp`, `nlerp`, `lerp`, `math`, `pmndrs`,
`wgpu-matrix`, `three`, and `glMatrix` anywhere in the seed files and both prompts.

The body is rotation-only at the origin, with three exact-color markers fixed to it: red centered
at body-local `[2,0,0]`, green at `[0,2,0]`, blue at `[0,0,2]`. Each marker may be a cube with edge
`0.4` or a sphere with diameter `0.4`. The camera is at `[0,0,10]` with identity orientation,
orthographic bounds x −4..4 and y −3..3, near 0.1, far 20. Each output frame reports `world`, the
body's column-major 4×4 rotation with zero translation. Because `world` is a rotation matrix, `q`
and `−q` produce identical output.

### Prompts

Turn 1, with the neutral ending:

```text
Build the headless keyframed-rotation renderer described in contract.md.
Its entry point must be `node render.mjs <input.json> <output-directory>`.
Use `npx vgpu`.
```

Turn 2 discloses one change, endpoint clamping:

```text
The animation now needs frame times before the first keyframe and after the last one. Update the renderer so those frames hold the first or last keyframe's orientation.
Everything else in contract.md still applies.
```

Sign handling is not hinted in turn 2. The turn-1 contract already requires it: a quaternion and
its negation denote the same orientation, and every segment takes the smaller angle. The turn-2
input varies only documented inputs.

The prompt keeps the neutral ``Use `npx vgpu`.`` wording. When the agent loads the skill, the
skill's own no-install instructions for finding the local version apply. Which command form the
agent runs is recorded as an observation.

### Fixture

| Turn | Keyframe times | Frame times |
| --- | --- | --- |
| 1 | `0, 1, 2.5, 3` | `0, 0.22, 0.75, 1, 1.35, 2.1, 2.5, 2.8, 3` |
| 2 | `0, 1, 2.5, 3, 4` | `-0.5, 0, 0.75, 1.35, 2.1, 2.8, 3, 3.3, 3.7, 4, 4.6` |

The keys are noncommuting 3D orientations; segment angles are 165°, 125°, 60°, and, in turn 2, a
new segment of about 40° to the key at `t = 4`. Turn 1 stores every key with a positive dot product
to its predecessor, so it does not exercise sign handling. Turn 2 keeps the same orientations but
stores the key at `t = 2.5` and the new key with the opposite sign, so three of its four segments
have a negative stored dot product, and it adds frames outside the key range. The turn-1 frames that
recur in turn 2 act as a regression.

A deterministic test freezes both inputs by SHA-256 (`c24f904a…` for turn 1, `8793962f…` for
turn 2) and asserts these invariants on every frame: unit keys within `1e-12`, every segment at
most 170°, projected marker centers at least `√3·0.4·64 + 8 ≈ 52.3` px apart (68.6 px measured), and
every center at least 40 px inside the image (68.0 px measured).

### Grading

The oracle in `evals/lib/scene-keyframes.mjs` is scalar code that never enters the sandbox and
imports no `math` and no `wgpu-matrix`. It clamps `t` to the key range, finds the segment, negates
the second key when the dot product is negative, interpolates at constant angular speed
(`a·sin((1−u)θ)/sinθ + b·sin(uθ)/sinθ`), normalizes, and builds the column-major rotation matrix. A
test checks it against the closed form `a ⊗ exp(u·log(a⁻¹b))` within `1e-12`.

Every gate is hard, on every turn and every frame. A turn passes only when all pass.

| Gate | Passes when | Does not prove |
| --- | --- | --- |
| `source-execution` | The fresh copy exits 0 within 60 s and writes `result.json`, after the native health probe passed | Correctness, or that the source is idiomatic |
| `protocol` | `version`, `requestId`, frame count, `index` equal to array position, a relative `color` path below the output directory, and 16 finite numbers in `world` | That the values are correct |
| `artifacts` | Every PNG decodes at 512×384 with a full RGBA buffer | What the images show |
| `state` | Every `world` value is within `1e-4` of the oracle | That the image was rendered from that state |
| `pixels` | Per frame, see below | Exact interpolation, marker shape, or GPU provenance |

Per frame, the pixel gate classifies pixels by exact marker RGB within ±2. For each color, the blob
centroid must lie within 3 px of the oracle's projected center, and its area must be 328–1,311 px.
At least 99% of the non-black pixels must lie within 25.2 px (`√3·0.2·64 + 3`) of one of the three
expected centers, and a frame with no non-black pixels fails. Under the orthographic camera, the
centroid of any centrally symmetric marker is its projected center, so cubes and spheres both pass;
no gate inspects shape or tessellation.

The pixel gate is a centroid, area, and containment check, not exact shape validation. It shows that
each marker appears in the right place at a plausible size. A normalized linear blend moves markers
by at most about 14 px on these fixtures, so the state gate catches interpolation faults and the
pixel gate catches render and publish faults. A passing health probe plus source execution does not
attest that the GPU produced the pixels; see [Trust model and limits](#trust-model-and-limits).

Outcomes stay `pass`, `application-failure`, and `infrastructure-error`, as for the other tasks.

### Initial dependency state

`math` must be absent before the first turn — from `node_modules`, from every `package-lock.json`
entry including nested ones, from every `package.json` dependency field, and from `npm ls math
--all`. Bootstrap installs no experiment dependencies for this task: only the vgpu tarballs and
`pngjs`, as for the other scene tasks. A failed absence check is an infrastructure error that blocks
the run, never an agent failure.

Absence evidence fails closed. Bootstrap must read and parse an object from `package.json`, an
object with a `packages` map from `package-lock.json`, and an object from the `npm ls` JSON output;
a missing or malformed read cannot prove absence. The accepted bootstrap snapshot is written at
`initialDependencySnapshot`. It records the manifest, lock, and dependency-tree SHA-256 values and
parse errors, every declared or locked `math` location, and the observed `math`, `wgpu-matrix`, and
`three` package versions. The same schema is captured after each turn at
`turns[].dependencySnapshot`.

Eve can build a cold template lazily during the first `t.send`. Each saved turn rereads the
bootstrap receipt and validates its template/seed identity before copying the initial snapshot;
capturing it when the eval function first starts can incorrectly record `null`.

`wgpu-matrix`, which has a shortest-arc quaternion interpolation, stays installed as a direct
runtime dependency of vgpu. It is importable without any install and is not removed to steer the
agent. Using it is a correct alternative, and results report it separately from `math`.

After bootstrap the agent may install anything. Install attempts and their exit codes are recorded
separately from the dependency state that results, per turn.

### Skill delivery

`agent/skills/vgpu.ts` is an Eve dynamic skill resolved on `session.started`. It returns the public
skill only when `VGPU_EVALS_TASK` is `scene-quaternion-keyframes` and `null` for every other task,
so no other task advertises a new skill. The launcher reads the generated `skills/vgpu/SKILL.md`
and its sibling `scene.md`, exits **2** if either file or the skill generator source is missing,
and passes the entrypoint path and file SHA-256 values to the runtime. The resolver rereads both files and
throws on a hash mismatch, so a stale or task-specific copy cannot be served. Both files' bytes
enter this task's seed hash only, so a skill change rebuilds this task's template and no other.

`SKILL.md` and `scene.md` are delivered as sibling files; the skill's `blender/` resources are
not, and this task does not need them. Loading the entrypoint does not automatically read the
scene reference; its availability is not evidence that the agent read it. The generic agent
instructions and the prompts are unchanged. Before a pilot, Eve's mock
model receives a no-resolver baseline and null-resolver captures for the other tasks; their
model-visible system prompts and framework tool lists must be identical.

"Advertised" and "loaded" are recorded separately. Advertisement requires exact out-of-workspace
materialization evidence from the sandbox. Eve removes SKILL.md frontmatter before returning
`load_skill`, so the frozen full-markdown
hash and expected delivered-body hash are different. Loaded requires a completed
`load_skill("vgpu")` whose actual string result has exactly the expected body hash; a missing output,
failed call, wrong skill name, full-markdown result, or mutated body is not successful. A session
that only advertised the skill is reported as "advertised, not loaded", never as having read it.

Advertisement is observed rather than inferred from launcher configuration. At turn completion,
the hook resolves the sandbox `$HOME`, reads `$HOME/.agents/skills/vgpu/SKILL.md`, and records its
path, existence, full hash, and whether it is outside `/workspace`. `advertised` is true only when
that file exists outside the graded workspace and its full hash exactly matches the frozen skill,
and the sibling `scene.md` exists with the frozen reference hash. The hook records the reference
path, expected and observed hashes, and match result under `sceneReference`.
A missing file, one-byte mutation, or Eve's `/workspace/skills/` fallback records
`integrity: "infrastructure-error"` and cannot be reported as advertised.

The skill-isolation check uses Eve 0.29.5's dynamic-skill lifecycle, `mockModel`, an
in-memory `SandboxSession`, and Eve's actual `load_skill` implementation. It verifies byte-identical
model-visible prompts and tools for `scene-robot-arm`, `scene-math-interop`, and `s2-gradient`, then
loads the target skill, verifies that `scene.md` is materialized alongside it, and rejects a
mutated entrypoint body. The historical pilot below delivered only `SKILL.md`; the split reference
was introduced afterward. Its [two-session follow-up](scene-skill-split-findings.md) verified
reference delivery, but neither agent read the skill or reference.

For the historical pilot's frozen package Git
`b6ec97a379e238cb37f492e30a73cdcad03e908d`, the advertised full-markdown hash is
`31011aa5d7e62408cc21619de2af0dee2062b75646df398dc3bbf3bdae22b51c` and the delivered body hash is
`285789ace4fd0f82333c5a6d471a76f73d7ccbc907e00bb7f5d2448e48ec50e3`. Evidence is in
`.work/skill-isolation/2026-09-30T18-34-36-088Z-c95ef7d0-e928-4cd6-bf37-939e76d6c61e/summary.json`.
This isolation check exercises Eve internals directly; it does not prove real-wrapper skill
discovery or Docker environment propagation. No separate zero-cost real-wrapper Docker discovery
check is implemented. The first paid turn therefore supplies the production-path materialization
evidence, and the lead-owned runner must stop and exclude the session from behavioral claims when
advertisement integrity is not `pass`.

`scene-run.json` exposes the provenance at these concrete paths:

| Path | Meaning |
| --- | --- |
| `skillDelivery.expectedAdvertisedFullMarkdownSha256` | Frozen full generated `SKILL.md` hash supplied by the launcher |
| `skillDelivery.advertisedFullMarkdownSha256` | Observed full hash, populated only when exact out-of-workspace materialization proves advertisement |
| `skillDelivery.observedAdvertisedFullMarkdownSha256` | Observed full hash even when it is mismatched |
| `skillDelivery.materializedPath`, `skillDelivery.materializedPresent` | Actual sandbox materialization path and existence |
| `skillDelivery.materializedSha256`, `skillDelivery.materializedOutsideWorkspace` | Actual full hash and isolation from the graded workspace |
| `skillDelivery.advertisementIntegrity`, `skillDelivery.advertisementError` | `pass` or `infrastructure-error`, with the concrete failure |
| `skillDelivery.expectedLoadedBodySha256` | Expected `load_skill` result after Eve removes frontmatter |
| `skillDelivery.expectedSceneReferenceSha256` | Frozen authored `scene.md` hash supplied by the launcher |
| `skillDelivery.sceneReference` | Observed reference path, expected/actual hashes and match result; does not imply a read |
| `skillDelivery.generatorSha256` | Skill generator source identity |
| `skillDelivery.packageGitHead` | Git revision used by the packed vgpu packages |
| `skillDelivery.workspaceGitHead`, `skillDelivery.workspaceDirty` | App/harness checkout identity; the dirty flag is expected before the lead-owned commit |
| `skillDelivery.harnessAggregateSha256`, `skillDelivery.harnessFiles[]` | Aggregate and per-file identities for the uncommitted harness |
| `initialDependencySnapshot` | Fail-closed dependency evidence after bootstrap and before turn 1 |
| `turns[].dependencySnapshot` | Dependency evidence after that turn |
| `turns[].complete.skillAdvertisementSnapshot` | Hook receipt with checked paths and materialization evidence |
| `turns[].skill.advertisedFullMarkdownSha256` | Exact observed advertised hash, or `null` when integrity failed |
| `turns[].skill.materializedPath`, `materializedPresent`, `materializedSha256`, `materializedOutsideWorkspace` | Per-turn copy of the observed sandbox evidence |
| `turns[].skill.advertisementIntegrity`, `advertisementError` | Per-turn production-path integrity result |
| `turns[].skill.expectedLoadedBodySha256` | Expected delivered body identity copied into the turn |
| `turns[].skill.loadCalls[]` | Every `load_skill` call, status, observed body hash, expected-hash match, and success |
| `turns[].skill.loaded` | Whether any call completed for `vgpu` with the exact expected body hash |

### Observations

Recorded per turn, never a gate and never part of the outcome:

- skill: advertised, loaded, and its identity (delivered SHA-256, generator SHA-256);
- docs exposure: `vgpu docs` calls, whether the scene-math guide surfaced or was opened, and any
  filesystem `/guides` searches;
- installs: commands, exit codes, per-turn `package.json` and lock changes, and the installed
  `math` version;
- the command form used to run the vgpu CLI;
- authored imports, as regex source hints only;
- clarifications, steps, tokens, and cost.

After each completed pilot session, a blinded source review classifies each turn's interpolation
source as `math`, `wgpu-matrix`, `three`, another library, or handwritten, and checks whether a
handwritten kernel is correct. An import alone is not evidence that the package executed.

### Running the pilot

The pilot is lead-owned. It starts only after the local tests pass, the
native controls pass, and an independent review of the implementation is complete. Correct
alternative controls — a handwritten kernel, `math`, `wgpu-matrix`, and sphere markers — must pass,
and broken interpolation, sign, clamping, and render controls must fail their intended gate while
still producing valid output.

The final pre-pilot Docker control command used the pinned image and package source key
`6122d243c06747f2`:

```bash
VGPU_EVALS_DOCKER_IMAGE='ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c' \
  fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs \
  --task scene-quaternion-keyframes --backend docker
```

All 28 scheduled stage/case pairs passed their assessments. The four correct implementations
passed both turns; every broken control rendered successfully and failed its intended state or
pixel gate, while the turn-1 `long-arc` and `no-clamp` diagnostic passes remained expected.
Evidence is in
`.work/scene-controls/2026-09-30T18-32-49.955Z-fd59a30c/scene-quaternion-keyframes/summary.json`.

The lead freezes the harness, the skill, and the packages, then runs two fresh sessions serially,
two turns each, with `anthropic/claude-sonnet-5` through the project OIDC token and the pinned
image:

```bash
fnm exec --using=22 pnpm build
fnm exec --using=22 node apps/agent-evals/scripts/pack-vgpu.mjs --skip-build

export VGPU_EVALS_MODEL=anthropic/claude-sonnet-5
export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
fnm exec --using=24 node scripts/agent-evals.mjs --task scene-quaternion-keyframes --skip-pack \
  --max-concurrency 1 --timeout 1200000 --verbose
```

The [OIDC guard](#model-access-project-oidc-only) applies unchanged. Every attempt is retained, and
an application failure is never retried. An infrastructure or auth failure is recorded separately
and may be rerun, labeled, under a new slot number.

Two sessions support per-session observations only: whether the skill was loaded, whether the
guide was reached, which interpolation source was chosen, whether each turn's output was correct,
and cost. They support no rates and no confidence intervals. A carry-forward rerun of turn-1 source
on the turn-2 input is optional; without it the report makes no measured-adaptation claim.

### Limitations

- Skill availability and actual loading are reported separately; availability alone does not
  establish that the agent used the guidance.
- `wgpu-matrix` is importable without an install; its use is a legitimate alternative, reported
  separately.
- The pixel gate is centroid, area, and containment only. A normalized linear blend is caught
  mainly by the state gate.
- One rotating body tests orientation interpolation only, not general scene composition.
- Turn 1 does not exercise sign handling on purpose. A solution without sign alignment passes
  turn 1 while violating its contract; turn 2 detects it.
- Mesa llvmpipe gives functional results only: no hardware-GPU or performance evidence.

## How a turn is verified

After every completed turn, the `turn.completed` hook in `agent/hooks/finalize-turn.ts` runs these
steps in the live sandbox. They all happen before the next agent turn starts:

1. **Resolve the stage.** The hook requires the event's `turnId` and `meta.id`; if either is
   missing, that is an infrastructure error. The stage is the position of the `turnId` among the
   distinct turns recorded in `turns/order.json`, not a count of hook callbacks. Eve delivers
   hooks at least once, so a retried completion event can arrive for the same `turnId`. It keeps
   that turn's stage and gets a new attempt directory. The stage is recorded before any
   verification runs, so a failed first hook cannot demote the next logical turn to stage 1.
2. **Archive the submission.** The hook tars `/workspace` before any verifier output exists. It
   excludes `node_modules`, `.git`, `.vgpu-tarballs` and `.next`. The tar is written as
   `workspace.tar` plus `workspace.tar.sha256` under the exact turn and event (see
   [Artifacts](#artifacts)). It is also written to the legacy session path.
3. **Copy the source outside `/workspace`.** `/workspace` is copied into
   `/var/tmp/vgpu-scene-<uuid>/app/`, and `/workspace/node_modules` is symlinked into the copy.
   The host-selected `input.json` and an empty `output/` directory sit next to `app/`. Digests of
   `/workspace` taken before and after the run record whether the program wrote there by absolute
   path. That is observed, not prevented.
4. **Probe native health.** A small `vgpu/node` probe clears a 4×4 `rgba8unorm` target and reads
   it back. It runs from `app/` with a 30-second cap and is deleted before the submission runs.
   If the probe fails or times out, the turn is an infrastructure error and `render.mjs` does not
   run.
5. **Run the submission with a time limit.** `node render.mjs <input> <output>` runs with `app/`
   as its working directory. It gets 60 seconds; on timeout the whole process group is killed with
   `SIGKILL`. The hook keeps the exit code, signal, elapsed time, Node version, platform and
   architecture, plus the last 64 KiB of stdout and of stderr.
6. **Export evidence, then clean up.** The following files are packed into `verify.tar` in `/tmp`,
   outside the temporary tree:
   - the output directory;
   - input, probe and execution records;
   - a SHA-256 manifest of the copied source, plus fixture hashes for the shader and interop
     tasks;
   - `verdict.json`.

   After packing, the hook removes the temporary tree and checks that it is gone. It copies
   `verify.tar` to the host and deletes the sandbox copy. `complete.json` is the last file
   written. If cleanup or export fails, or the turn is classified as an infrastructure error, the
   hook throws.

Grading runs on the host and holds the expected matrices, masks and verdict. None of these enter
the sandbox. The grader reads only the exported rerun output, never PNGs the agent left in its
workspace.

The source copy leaves out only these top-level directories of `/workspace`:

- `node_modules`
- `.git`
- `.vgpu-tarballs`
- `.agent-evals`
- `.next`
- `.cache`
- `.work`

Everything else is copied, including authored top-level or nested `build/` and `dist/`
directories. Source and assets the program needs at runtime must not live in an excluded root
directory. Address them by paths that survive the copy, for example relative to
`import.meta.url`.

Both the live sandbox copy and the host executor used by controls apply this root-only exclusion
list. The sandbox `tar` copy preserves symbolic links while the host executor skips them, so a
submission must not depend on symlinked source or assets for portable control behavior.

The eval (`evals/lib/scene-eval.ts`) sends both turns in one session with a 20-minute
`timeoutMs`. It grades turn 1 from that exact completion event's archive before sending turn 2,
continues to the follow-up after an ordinary turn-1 correctness failure to observe recovery, and
stops on an infrastructure error. It never falls back to the session's latest export for scene
grading.

## Hard gates

Each check is a labeled `t.check(..., equals(true))`. Robot color coverage is gated per part and
per frame, and robot containment is gated per frame; its aggregate ratios are diagnostic only.
Other checks cover the complete batch as described below. "Non-background" means a pixel that
differs from `[0,0,0]` by more than 2 in any channel.

| Check | Passes when |
| --- | --- |
| `protocol` | `version`, `requestId`, frame count, zero-based ordered `index`, string `color` (and `ids` for warehouse), and an object `state` on every frame |
| `artifacts` | Every image path is relative and stays below the output directory, and decodes at the task's size with a full RGBA buffer |
| `robot-matrices` | All five joint matrices on every frame are 16 finite numbers within `1e-4` of the host reference |
| `robot-pixels` | On every frame, every part has a nonempty expected interior with ≥ 98% RGB matches within ±2, including the tip marker; on every frame ≥ 99% of non-background pixels lie inside the union of silhouettes dilated by 2 px |
| `fixture-file-unmodified` | `integration.wgsl` is byte-identical to the supplied fixture |
| `shader-state` | `viewProjection` within `1e-4` of the host reference and all three origins unchanged within `1e-4`, on every frame |
| `shader-pixels` | ≥ 98% of rectangle-interior pixels match 223/32 within ±2; ≥ 99% of non-background pixels inside the rectangles dilated by 2 px |
| `warehouse-state` | Exact `count`; items sorted by `appId` with exact IDs and positions/tints within `1e-4` of the independently applied operations |
| `warehouse-pixels` | See below |

Robot interiors come from each part's front rectangle projected with the host transforms, at pixel
centers, using true distance to the rotated edges — not an axis-aligned bounding box. A pixel is
expected to show the frontmost raw silhouette covering it, and only when it lies at least 2 px
inside that silhouette's edges. The magenta tip is frontmost by construction, so overlap handling
never removes it; its interior is only about 3–4 px across per frame, so a frame without the
marker fails that frame's tip-part ratio directly.

Shader rectangles are 38.4 × 38.4 px, centered on each origin projected through the frame's
camera, with the same 2 px interior band.

`warehouse-pixels` fails if any of these hold on any frame:

- an ID-image pixel carries an ID that is not live, including deleted IDs;
- an ID pixel's color-image pixel differs from that item's tint by more than 2, or the pixel lies
  more than 4.6 px from the item's projected center on either axis (the 7.2 px box dilated by 1 px);
- an ID-zero pixel is not black in the color image, which covers deleted and vacated cells;
- the set of nonzero IDs in the image differs from the live set;
- a live ID covers fewer than 40 or more than 81 pixels;
- the 3×3 neighborhood at an item's projected center lacks the exact ID or its color within ±2.

The host reference math in `evals/lib/scene-math.mjs` is scalar code independent of `vgpu/scene`,
of the reference control, and of anything the submission reports. Numeric state proves nothing
about the image and the image proves nothing about the state: each is graded against the host
reference separately, so correct CPU matrices paired with a stale image fail, and so does the
reverse.

## Observations (never gated)

Recorded per turn for the lead's review, never a pass/fail input:

- the transform path actually used (scene hierarchy, flat arrays, hand-written matrices);
- scene API adoption, binding refresh strategy, stable-ID handling, batching;
- observed rendering and readback calls in the source;
- commands run and docs usage, from `bashCalls`/`docsUsage` in `evals/lib/transcript.ts`;
- draw counts, recorded as unknown when the evidence does not show them.

An import, or prose saying an API was used, is not evidence that it executed. A valid alternative
implementation passes the hard gates, and gating adoption would reward ritual rather than working
output. The automated source fields are regex-derived source hints only; semantic lead review
separately determines whether a shader was actually loaded and bindings or scene APIs were used.

## Outcome classifications

| Outcome | Examples |
| --- | --- |
| `pass` | The rerun exited 0 within 60 s and every hard gate passed |
| `application-failure` | Missing `render.mjs`, nonzero exit, timeout, wrong or missing JSON, corrupt/wrong-size PNGs, an escaping output path, any failed gate — all in a healthy environment |
| `infrastructure-error` | Missing archive or identifiers, sandbox transport/setup failure, failed native health probe, doctor/startup failure, cleanup failure, an oracle bug |

A failure the evidence cannot attribute stays explicitly unclassified pending lead inspection; it
is never silently blamed on the model. The host verdict is authoritative.

## Artifacts

All raw evidence is ignored by git and stays under `apps/agent-evals/.work/` and Eve's `.eve/`:

| Path | Contents |
| --- | --- |
| `.work/tarballs/tarballs.json` | Pack manifest: `sourceKey`, git SHA/branch, tarball list |
| `.work/snapshots/<sessionId>/workspace.tar` | Legacy latest-turn export, still written for older task readers |
| `.work/snapshots/<sessionId>/turns/order.json` | First-seen `turnId`s in order; defines the stage |
| `.work/snapshots/<sessionId>/turns/<turnId>/<eventId>/workspace.tar` | Immutable submission for one completion attempt, plus `workspace.tar.sha256` |
| `.work/snapshots/<sessionId>/turns/<turnId>/<eventId>/verify.tar` | Rerun input, probe and execution records, `output/` (`result.json` and PNGs), source manifest, fixture hash, `verdict.json` |
| `.work/snapshots/<sessionId>/turns/<turnId>/<eventId>/complete.json` | Stage, IDs, input hash, classification, cleanup/export status; written last |
| `.work/scene-controls/<timestamp>-<unique-id>/<task>/summary.json` | One native control run |

`turnId` and `eventId` are URL-encoded into path segments.

The sandbox verdict records these fields:

- task, stage, turn ID and event `meta.id`;
- the SHA-256 of the input;
- the command, working directory and timeout;
- the probe and execution records;
- the host runtime and the sandbox runtime;
- the source-copy exclusions;
- whether a `/workspace` mutation was observed;
- its stated limitations.

The host-side grade adds:

- the contract revision;
- commit, `sourceKey` and tarball hashes;
- the model slug;
- the Eve version;
- the Docker image digest where available;
- raw check measurements.

Provider usage that Eve did not report is marked unavailable, never estimated.

Scene readers use only exact `turnId`/`eventId` coordinates. The legacy session path exists so
existing tasks keep working; scene grading never reads it.

## Budgets

- **60 seconds** per `render.mjs` invocation, including killing a hung child.
- **20 minutes** per task run (`timeoutMs: 1200000`, `--timeout 1200000`).
- The OIDC token must have at least **25 minutes** left: the 20-minute run plus 5 minutes of setup.

## Model access: project OIDC only

Scene tasks accept exactly one credential: a `VERCEL_OIDC_TOKEN` from the configured Vercel project,
routed through AI Gateway. The guard in `agent/lib/scene-auth.mjs` runs in the launcher before the
explicit-model preflight and before packing, and again in the scene driver before the first
`t.send`, so a direct `eve eval` is covered too. It fails when:

- any of `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
  `GOOGLE_GENERATIVE_AI_API_KEY` is set — alone or alongside the OIDC token;
- `VERCEL_OIDC_TOKEN` is absent, not a three-segment JWT, or has no numeric `exp`;
- fewer than 25 minutes remain before `exp`.

A failure is an environment error; a scene run does not skip silently for lack of a token. The
guard only decodes the expiry locally: it makes no request, validates no signature, never prints
the token, and never refreshes or rewrites credentials. If your shell or `.env.local` contains a
competing key, run from an environment that holds only the project token. Scene evals add no judge
calls; any later optional judge must use the same OIDC path and stay observational.

Other tasks keep their existing routing.

## Trust model and limits

Scene grading assumes a **non-adversarial** agent. The rerun and the source copy remove two failure
modes of earlier tasks — grading a file the agent left behind, and grading output from the
agent's own working directory — but verification still executes inside the container the agent
had root in for its whole turn, with its installed dependencies. See
[Trust model](README.md#trust-model-v0) for why no in-container gate is proof against an agent
optimizing to pass.

Rereading a produced PNG and checking its geometry does not prove GPU provenance or use of scene
APIs. A CPU-painted image, pixels uploaded to a texture, or an unused import cannot be ruled out
by these checks. There is no runtime module tracing, readback preload, or prototype wrapping in
this revision. The lead's source and transcript review is what distinguishes a correct
alternative implementation from a bypass or an unsupported claim; bypass and unknown are recorded
separately from correctness, and adoption never becomes a gate.

The rerun also trusts the sandbox's installed dependency tree. Missing dependencies are reported
in the native-health reason, but deliberate dependency tampering is not attributed or prevented.
The source-copy boundary does not harden symlink targets or prevent absolute writes; symlink/path
behavior and `/workspace` mutation are retained as limitations and evidence for lead review.

Native controls demonstrate that correct GPU output passes and that each named fault is caught on
a given environment. They do not attest to anything a submission did.
