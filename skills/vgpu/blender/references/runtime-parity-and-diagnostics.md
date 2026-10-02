# Runtime parity and diagnostics

Use this reference when an authored asset looks wrong in the target renderer and the cause could
be geometry, baked data or runtime composition. Preserve the source mesh and validated masters
while isolating the failure; rebake only when evidence identifies an affected bake dependency.
Use the target package's installed documentation for runtime APIs, as described in the
[parent skill](../../SKILL.md).

## Classify the defect's origin

Reproduce the defect with a fixed camera, lighting, exposure and simulation time. Change one
contribution at a time and retain the full view plus a defect crop. A disappearing symptom locates
a path to investigate; it does not by itself prove which input or operation in that path is wrong.

| Candidate source | Distinguishing comparison | What to inspect next |
| --- | --- | --- |
| Geometry or export | Neutral unlit material, maps disabled; compare authoring and imported silhouettes, openings and contacts | Evaluated mesh, transforms, winding, overlap and exported attributes |
| Shading normals or normal maps | Neutral lit material, then geometric and tiled normal layers independently, when present | Base normals, tangent frames, UVs, decoding and projection correspondence |
| AO or baked illumination | Neutral AO versus real AO; lightmap independently disabled, with direct and indirect terms identified | Map values, channels, UV bindings and missing or doubled lighting terms |
| Runtime lighting or material interpretation | Keep geometry fixed; isolate direct light, environment lighting and tone mapping | Light direction/space, radiometry, material parameters and color conversion |
| Reflections or other offscreen passes | Compare the pass output with its final composite and with the effect disabled | Pass camera, resource bindings, uniforms, update/submission order and compositing |
| Fog or scene composition | Compare the same view with the effect enabled and disabled across objects and background | Shared inputs, view direction, distance definition, effect ordering and per-material paths |

For example, a band that appears only in a reflection warrants inspection of the reflection pass
before changing the object's UVs. A dark patch that disappears with AO disabled still needs a
comparison between the baked texels and the runtime sample to distinguish a bake fault from a
binding fault. Return to [baking diagnostics](baking-and-diagnostics.md) when that boundary is known.

## Check coherence across surfaces

When changing a scene-wide effect, enumerate the paths that consume it: for example, the sky,
water, terrain and opaque meshes may implement fog separately. Review them together in one
matched frame, including their contacts and background transitions; an isolated corrected surface
can expose a mismatch on its neighbors.

Compare common quantities in the same coordinate and color spaces, with compatible intensity,
distance and blend conventions. Inspect supported branches affected by the edit, such as an
alternate environment or disabled reflection. Shared code or parameters can prevent drift, but
the actual outputs still need review. Consistency does not mean forcing different materials to
the same final color: preserve intentional reflectance, transparency and lighting differences.

A reproducible fog check is to place a simple opaque object against the water/background, render
matched effect-on/off views, and inspect the fade at comparable view distances. If both paths are
intended to converge to the same background radiance, a new halo at their boundary is a regression.
Correcting that composition should not silently change material lighting or bake inputs; if it
does, apply the existing [bake dependency rules](baking-and-diagnostics.md#reuse-bakes-by-their-dependencies).

## Strengthen isolated tests

For a shader or render-pass defect, prefer a small project-owned `vgpu/node` probe when the target
version and device support it. Import the production shader and binding/setup code involved in
the failure; a separately rewritten approximation can pass while the application remains broken.
Keep probe entry points and diagnostic fixtures outside the shipped application bundle.

Use a synthetic input with an unambiguous expected result: a direction-coded environment with a
distinct marker, neutral and known-value textures, or an object/face ID output. Record what the
probe proves and what it omits. A useful camera/pass regression procedure is:

1. Render the intended pass alone with distinguishable camera inputs and save its readback as a reference.
2. Exercise the same path in the application's relevant multi-pass/update sequence.
3. Check the expected marker or region and compare with the reference using a stated tolerance.
   When order independence is expected, reverse the pass order as an additional check.
4. Confirm that the historical failing implementation or a controlled faulty fixture fails the
   same assertion. Keep the faulty variant confined to the test; do not ship a diagnostic mode.

Choose assertions from the intended output rather than arbitrary screenshot changes. Collect GPU
validation errors and await completed submission/readback. A mock or CPU transcription can help
explain the calculation but does not establish execution by the actual GPU shader. An isolated
native pass also does not prove full-scene correctness, browser integration or interaction; verify
the affected paths in the application after the probe passes.

## Tie evidence to the rendered version

Record enough identity beside each run to distinguish an edited source from the build actually
executed. Use the project's existing manifest/report mechanism when available:

| Evidence | Record |
| --- | --- |
| Inputs | Source revision plus relevant dirty-source snapshot/hashes; shader, asset and map identities; runtime/tool versions |
| Execution | Exact command or preset; actual build/served identity; renderer/backend and adapter; camera, viewport/internal resolution, exposure, time and seed |
| Result | Output paths, measured comparison and tolerance, validation errors, terminal completion/exit status and limitations |

A commit alone does not identify uncommitted edits, and the current working tree does not prove
which shader a running server loaded. Resolve identity mismatches before using a capture to accept
a change. Retain the previous run separately rather than overwriting its report with new sources.
Reuse older evidence only for inputs and paths shown to be unchanged, and state that scope.

Read logs after the producing process finishes: an empty or partial log is neither a pass nor a
failure. Keep queued, running, completed, failed and unexecuted checks distinguishable. For image
comparisons, record excluded regions (such as DOM controls) and their reason; do not mask the
artifact being tested. Do not claim pixel equality across devices or browser modes without
measuring it under the recorded conditions.
