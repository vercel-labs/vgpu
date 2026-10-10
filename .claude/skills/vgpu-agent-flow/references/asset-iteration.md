# Blender asset iteration

Use this lane when the user requests an authored Blender asset, screenshot-driven refinement,
or an ImageGen concept translated into a runtime example. Follow the selected repository workflow;
reuse the user's creative delegation instead of inventing a public-API approval stage.

`repo:asset-author` runs Astra (`gpt-6-astra`) with two declared Opus 5.5 children:
`subagent:runtime` specializes in shaders and disjoint browser rendering files; `subagent:critic` reviews actual captures
and costs. These roles intentionally have no model fallback: report unavailable requested models.
Reading a skill does not grant a CLI child access to the lead's image-generation tools.

Astra owns modeling, Blender renders, authored materials, environment design, camera composition,
lighting and AO/indirect bakes. It uses actual Blender renders to refine concepts and directs the
next visual change. Opus owns runtime PBR and baked-lighting composition, sky/water shaders,
reflections, shadows and color-management parity with that scene. If native Blender execution
requires the lead, Astra still specifies the render and inspects the returned images; the lead
provides execution support without transferring artistic ownership to the runtime child.

Before launch, put the scope, file ownership, target renderer/cameras, output paths, budget and
iteration cap in `.context/work/<topic>/brief.md` and `decisions.md`. Numeric budgets belong to
the task. If omitted, use three revisions with at most two critic passes per revision. Inspect
the topic's recorded lesson evidence when available; don't blindly copy past aesthetics.
Read `skills/vgpu/SKILL.md` and its Blender references, verify the installed Blender version,
and resolve runtime APIs through the target package's installed docs.

```sh
pnpm exec subharness check repo:asset-author
pnpm exec subharness check repo:asset-runtime
pnpm exec subharness check repo:asset-critic
pnpm exec subharness run repo:asset-author --prompt-file .context/work/<topic>/asset-task.md
```

Use native background commands or detached tasks as described in the parent skill. Check every
terminal outcome, including declared children. A readiness check is not proof of tool execution. Keep the author handoff compact:
delegate detailed runtime diagnostics and full capture review to the assigned children, then
read their result summaries and selected decisive images. Preserve comprehensive evidence on
disk instead of repeatedly loading every image and manifest into the parent. If the harness
fails with an input/context limit, retain completed artifacts and account for cancelled children's
partial writes before starting a fresh session with a concise handoff; retrying the same oversized
session does not recover it.

The lead generates a concept with the built-in ImageGen tool when requested, saves it in the topic,
and passes its path. The author, or the lead after a reported native block, supplies actual captures;
record who produced them. Inspect a capture before
using it as an ImageGen edit target; label its role and preserve silhouette, camera, scale and
attachments unless intentionally changing them. Save the reimagined image separately as a concept.
Translate selected changes into real geometry/materials, then capture the implementation again.
Never substitute a generated image for proof of a working model.

Use a file handoff while the author is active: `iteration-status.md` records revision, child IDs,
actual output paths and readiness/blockers; `image-request.md` records the edit target, prompt,
preserved invariants and desired result path. The lead reads these and sends the generated path
with `subharness send <author-session> --delivery steer --prompt-file <response-file>`. Use queued
follow-ups when idle. A final response also works when no independent work remains. Do not assume
the author can message the lead without this file/CLI handoff.

Give each shared handoff one writer. When the lead owns preview servers, the runtime child writes
its build request and the lead writes a separate current-service record with build hashes, asset
paths and ports. Read that record before captures and final reporting; do not append replies to a
request another agent will regenerate. Keep superseded build manifests and failed captures intact.
A queued child follow-up is not evidence that the running child has received a newer server state.

Use `queue` for follow-ups to the Opus runtime and critic children. In the current Subharness
Claude adapter, `steer` means interrupt: active work stops and a replacement task starts with
partial file effects preserved. Reserve it for deliberate interruption and inspect the reported
delivery mode and terminal outcomes. Lead-to-Codex-author steering supports in-place delivery.

Probe native execution before a long run. Blender may fail during Metal initialization in a macOS
child sandbox even though `--version` succeeds. Report the log and exact command instead of
retrying unchanged or broadening permissions. The lead can run Blender within its existing
authorization and return captures. Use `--python-exit-code 1`, check completion logs and validate
serialized assets: a process exit alone is insufficient evidence.

When agents continue editing during a native run, execute a verified source snapshot. Copy the
entry point and its local imports into a new directory, compare every copied hash with the
author's handoff, and keep that directory unchanged until completion. Record external inputs
separately. Release the editable sources after verification; a queued steering message alone
does not guarantee that an agent's in-flight edits have stopped. Check snapshot hashes again
at completion, and retain failed scene checkpoints before retrying a revised source.
When a copied helper imports installed packages, verify resolution from the snapshot before a
long bake. Copying the helper can change Node's package lookup path. Preserve the installed
dependency identity and use an explicit process-scoped lookup path when needed; a successful
import from the original directory does not test the copied execution context.

The runtime child may capture through a browser tool or an installed `agent-browser` CLI using
its Bash access. If unavailable, it reports `browser capture: not performed (<reason>)` and the
exact server/capture steps; the lead owns the outstanding check. Record the actual renderer backend
and test controls as well as saving the screenshot. A WebGL fallback does not prove WebGPU output.

For each iteration retain:

- source revision or parameters that reconstruct the previous asset;
- actual hero, rear and relevant close-up captures under recorded camera/light/pose settings;
- export triangles, vertices, primitive/material counts, file bytes and texture residency;
- runtime validation and measured draw counters, separately from offline estimates;
- critic findings, chosen fixes and the next measured result.

Each critic handoff includes both the previous and current captures/metrics, or explicitly says
the first revision has no implementation baseline. Generated references remain separately labeled.

Stop when the caller's visual requirements and measured budgets pass, or at the agreed iteration
cap with explicit remaining findings. Do not add an unattended infinite improvement loop. Keep
reproducible source and runtime assets outside scratch; save screenshots under `.context/`.

A cap is an execution limit, not a visual acceptance criterion. Keep a `REVISE` verdict when
reference fidelity remains unmet; never convert it to `PASS` merely because topology checks pass
or the revisions are exhausted. A user's rejection or changed brief reopens earlier acceptance.
For close-up or architectural work, choose texel density from the required view before baking:
tiled material detail and unique lighting UVs can preserve detail more economically than one
low-resolution unique atlas. Requested baked AO/lightmaps need actual bake provenance and matched
runtime captures with each contribution disabled independently.

For atlas repairs, compare the full matched views as well as the original defect crops. A new
layout may repair one edge while making another exposed face black. Minimum chart-box width,
positive triangle area and zero overlaps do not establish adequate raster coverage of visible
subregions. Use AO-off comparisons to locate candidates, then inspect the actual texture and
surface visibility to distinguish a bad bake from legitimate contact occlusion. Keep the
candidate out of delivery while confirmed regressions remain.

When changing terrain beside water, verify actual mesh contacts and its intersection with the
water plane. Manifold closure and source height samples are useful structural checks, but can
pass while the rendered coast contains unintended submerged pockets. Inspect elevated and
shoreline views and measure the resulting footprint before regenerating a shoreline field.

## Improve the team from observed results

Apply the repository [agent handoff contract](agent-handoffs.md) to author/runtime/critic
coordination. Keep coordination lessons in this pipeline and its agent definitions; put transferable
modeling, baking and runtime-validation guidance in `skills/vgpu/blender/`. Do not make the
portable Blender skill depend on Subharness roles, handoff files or repository-specific services.

Write candidate lessons in `.context/work/<topic>/lessons.md`: evidence path, observed symptom,
cause, intervention, matched before/after result and scope of applicability. The lead verifies
them and makes a narrow change to the relevant agent or this guide when the evidence justifies it.
Promote durable lessons with a reproducible procedure or a source fixture included in the same
delivery, so a later agent can recheck them without private task artifacts. Keep example-specific
case studies with their source evidence; do not make this lane depend on an unpublished example.
Reject unverified claims and task-specific style preferences
masquerading as general rules. This improves instructions and examples, not model weights.
