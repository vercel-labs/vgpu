# Explicit math/ECS interoperability pilot — September 29, 2026

Both agents used `math` in their submitted renderers and passed both turns: **2/2 sessions,
4/4 turns and 20/20 gates**. The runtime integration worked on this fixture, including shear,
parented cameras, instance publication and entity lifecycle changes. This supports keeping the
current array-based boundary as a workable integration; no alternative boundary was tested.
It does not justify making `math` a vgpu dependency.

This task explicitly requires `math@0.1.0` for camera projection/inversion and mesh composition,
plus `instances` and `instanceGeometry` for publication and drawing. It answers whether an agent
can follow that integration contract. It does not measure spontaneous adoption, whether `math`
improves performance, or the effect of the guide in isolation.

## What ran

- New task `scene-math-interop`, revision `scene-math-interop-v1`. The three neutral
  `scene-evals-v1` tasks and their seeds remain unchanged, checked against frozen fixtures.
- Two fresh serial `anthropic/claude-sonnet-5` sessions, two turns each, through project Vercel OIDC
  and AI Gateway. No failed attempt was retried or discarded.
- Eve 0.29.5; the pinned Docker image in [the eval instructions](scene-evals.md#scene-math-interop).
  Sandbox Node v24.20.0, `math@0.1.0`, six vgpu package archives at 0.5.0, packed runtime commit
  `b8981ef37621e14d711dc3cfb70c6d4b5f6d3d56`, source key `d0fd992ed2ba388e`.
- The existing ECS owns local/world buffers and generational handles. Turn one exercises hierarchy
  changes, shear, mesh offsets, camera movement and restoration. Turn two adds reparenting, spawning,
  cascading deletion, row reuse and a camera parent. Both inputs contain four frames.
- Every submitted source snapshot is executed afresh. A scalar oracle independent of `math` and the
  seeded ECS checks world/camera matrices, live keys, object coverage, depth ordering and image
  containment. ECS seed bytes must remain unchanged.

Runtime packages, harness files and inputs were frozen before the pilot. Source copies used in
review are checked against the executed source manifests. Exact hashes, source identities, model
usage and all outcomes are retained in [the results](scene-math-interop-results.json).

## Results

| Session | Turn 1 | Turn 2 | Steps | Generation cost | Clarifications |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | Pass | Pass | 79 | $2.9416 | 0 |
| 2 | Pass | Pass | 76 | $2.6548 | 0 |

Total: **155 steps, $5.5964**. Each session matched all **193,337 checked object pixels** across
its eight frames, with zero pixels outside the containment tolerance. Maximum matrix error was
`1.4486249533263162e-7` on turn one and `1.6682972869830337e-7` on turn two, for both sessions.
All ECS fixture hashes, executed-source identities and frozen package hashes matched.

Neither session had an infrastructure-classified failure or timeout. The launcher used host Node
v24.14.0, satisfying the eval application's Node 24 requirement while triggering pnpm warnings
about the root workspace's Node 22 range. Build and packing had used Node 22. Both sessions emitted
listener warnings and an Eve queue HTTP 503/socket-hang-up warning after completed results; both launcher
processes exited successfully. Those warnings remain in the raw logs. Both sessions used the same
correlated sandbox template with recorded package-lock, dependency-tree and math integrity hashes.

Costs are reported model-generation costs, including debugging, excluding specialist work,
preflights and infrastructure. Pixel matches refer to the independently checked eroded interiors,
not every image pixel. The tolerance is 1e-4 for matrices, at least 98% coverage per object, and
at least 99% containment.

## Source review and observations

The lead inspected source and grading evidence. An independent Claude Opus 5.5 specialist reviewed
both stages of each solution in anonymous code directories, with scores and transcripts withheld
until classification. The seeded ECS's own `math` import is excluded from adoption.

- Both solutions call `mat4.orthoZO`, `mat4.invert` and `mat4.multiply` in agent-authored code.
  Both build mesh transforms as `ecsWorld · T(offset) · S(size)` without decomposing the ECS world
  matrix or multiplying a parent twice. Neither implements handwritten matrix kernels.
- Both update the ECS before reading its authoritative world buffers, copy the rows into scratch
  values, use `instances` and `instanceGeometry`, call `publish()` explicitly, and draw with its
  returned count. Camera uniforms are set per frame.
- Both add lifecycle handling in turn two and retain key-to-handle mappings instead of treating
  external keys as rows. Camera-parent support follows from using the camera's ECS world matrix.
- Both also maintain their own parent/children bookkeeping, duplicating information in the ECS.
  Both recompose and upload every renderable each frame instead of consuming the ECS's changed
  rows. These choices are adequate for the fixture but weak evidence for efficient large scenes.
- Both agents received the worked math examples through `docs cat`, confirmed in the returned
  tool content. Delivery does not establish that those examples caused success.

The second solution deletes a despawned key's `parentOfKey` entry before reading it to unlink
that key from its parent's child set. The duplicate hierarchy therefore retains a dead child.
Its current traversal treats the later redundant visit harmlessly, and the fixture still passes;
this is a bookkeeping defect, not a demonstrated pixel failure. The supplied ECS already exposes
`isAlive()` and `entities()`, so an application can reconcile instance membership without maintaining
a second hierarchy. It does not expose a direct list of entities removed by a cascade.

The solutions use different WGSL vertex locations. This is valid: vgpu resolves named geometry
attributes against reflected shader inputs (`geometry-descriptor.ts`), rather than requiring the
bridge to use fixed shader locations. Both executions passed. This divergence is not an API defect.
The `leadResolutions` in the results file supersede the embedded source review's earlier
fixed-location concern and its claim that callers cannot discover which ECS handles died.

Both agents initially searched the filesystem for `/guides/scene-math.docs.md`, then opened it with
`npx vgpu docs cat`. A virtual documentation path can still look like a filesystem path even when
the prompt says to use `npx vgpu`. This is a concrete discovery issue to address in a future prompt
revision; it was not changed during this run.

## Conclusions and limits

1. Keep the existing explicit array boundary. These two agents successfully composed an external
   ECS, `math`, custom WGSL and vgpu publication without an adapter class or runtime dependency
   added to vgpu.
2. Keep this guided interoperability task alongside the unchanged neutral tasks. They measure
   different behavior: following an explicit integration contract versus choosing tools unaided.
3. In a future prompt revision, show the full `npx vgpu docs cat /guides/scene-math.docs.md` command.
   Both agents' filesystem detours give a specific discovery improvement to test.
4. Add a focused example using ECS live handles and changed rows before expanding the scene API.
   Then test sustained spawn/despawn churn and sparse updates separately, with explicit resource
   and upload measurements. Pixel correctness alone cannot establish efficient publication.

This is a small functional pilot, not a reliability estimate. The fixture uses boxes, orthographic
cameras and Z-axis rotations. It exercises affine shear but not arbitrary-axis rotations,
perspective, large-scene performance or hardware-GPU behavior. The renderer is Mesa/software
WebGPU. The generated renderers are JavaScript; they do not test TypeScript tuple compatibility.
Source review establishes what the submitted code does by inspection; there is no runtime
math-call tracer, ownership probe or protection against adversarial runtime patching.

Stage-one source was not rerun against stage-two input. Source changes can show added code, but
this report makes no measured adaptation claim. The previous neutral-task results remain separate;
the explicit requirements, ECS scaffold and clearer protocol prevent a causal before/after comparison.

## Validation and evidence

Implementation and runner each passed independent review, with findings fixed before the pilot.
Validation passed 54 local tests, the eval application's TypeScript check, 657 documentation snippets,
a root build, and five scratch orchestration tests. Native controls produced all 14 intended
outcomes: two correct renderers passed and twelve injected faults were rejected. Faults cover
matrix order, double parenting, lost shear, wrong depth convention, stale publication/camera,
missing descendant updates, unsupported lifecycle, row/key confusion, orphan instances and stale
instance counts, plus ignoring the camera's parent. The intentionally turn-one-only control fails execution on the second input;
the other negative controls render successfully and fail their intended checks.

Raw local evidence is retained under `.context/work/scene-math-interop/`,
`apps/agent-evals/.eve/evals/`, and `apps/agent-evals/.work/snapshots/<sessionId>/turns/`.
This change is private eval tooling: no published runtime API or migration changes.
The independent conclusions audit approved the report; its four wording corrections are included.
