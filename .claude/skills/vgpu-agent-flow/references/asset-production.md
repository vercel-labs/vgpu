# Produce runtime assets from detailed sources

Use this workflow when an authored model needs web delivery, a lower runtime cost, baked detail,
levels of detail (LODs), or compressed animation. For modeling-only work, use the
[asset iteration workflow](asset-iteration.md). Production does not imply redesigning the asset.

HIGH is the detailed authoring source. LOW is the mesh the application will render. A projection
cage is a mesh used to control rays that transfer surface detail from HIGH to LOW. A bake stores
that detail in a texture. A decoded export is the model and textures after the application's
actual loading/decompression path, not simply the file Blender exported.

## Choose ownership and inputs

| Role | Owns | Hands off |
| --- | --- | --- |
| `asset-author` or `blender-modeler` | Editable HIGH, authored appearance and reference renders | Pinned source revision, materials, rig and intended views |
| `asset-producer` | LOW, cages, UVs, bakes, LODs, packaging and production manifest | Decoded-output checks, runtime files and matching sources |
| `asset-runtime` | Loader, materials, rendering and resource lifetime | Actual runtime captures and resource measurements |
| `asset-critic` | Independent read-only assessment | Findings tied to the reviewed revision and image locations |
| `performance-engineer` | Measurement plan, raw runs and comparisons | Evidence-backed bottlenecks and bounded next experiments |

The lead assigns files and review ownership. Use separate worktrees for independent writers;
hand dependent tasks a committed revision or an immutable input snapshot. One person/agent may
perform several roles for a small task or when delegation is disabled. Do not launch every role
automatically. Concept images guide modeling but never certify implemented geometry.

Before production, record these project inputs in the assignment:

- Source paths and hashes; whether the editable `.blend` or a generator is authoritative.
- Runtime importer and supported extensions; units, axes, hierarchy, pivots and material channels.
- Closest camera distance/projected size, required rear views, instance count and motion range.
- Target devices/browser, drawing-buffer size and intended quality. Use task-specific budgets
  for download, decode, resident geometry/textures, draws and frame cost; mark unknown budgets.
- Durable source/output directories, evidence directory, permitted changes and iteration cap.

For example, a chair shown once in a product configurator needs close inspection from underneath.
The same chair repeated in a distant auditorium may need shared geometry and simpler LODs.
Neither use case supplies a universal triangle count or texture resolution.

## Decide the representation before baking

| Visible requirement | First choice | Verify |
| --- | --- | --- |
| Opening, thin support, silhouette or moving joint | Geometry | Rear/grazing views, contact and motion |
| Shallow engraving or small bevel | Projected normal map if it saves useful work | Highlight shape and final mips |
| Stable local contact | Ambient occlusion (AO) bake | Assembled occluders and indirect-lighting composition |
| Contact between moving parts | Runtime lighting/shadows | Intermediate poses; avoid frozen occlusion |
| Repeating surface grain | Shared material detail | Scale and tangent frame independent of unique bake UVs |
| Simple low-detail prop | Directly authored LOW | Skip unnecessary HIGH, cage and bake stages |

Normal maps cannot restore an opening or cast-shadow contour. Read the portable
[high-to-low guide](../../../../skills/vgpu/blender/references/high-to-low-baking.md) for projection,
and [local retopology](../../../../skills/vgpu/blender/references/local-retopology.md) when openings
produce thin triangles or distorted shading. For animation, read
[animation production](../../../../skills/vgpu/blender/references/animation-production.md).

## Run staged production

1. **Inventory and baseline.** Preserve the previous delivery and evaluate visible curves,
   instances and modifiers. Compare HIGH and unbaked LOW under matching cameras. Empty conversions
   or unexplained lost surfaces are failures, even if export exits successfully.
2. **Representative proof.** Choose a part with the difficult features: for example, a curved
   housing with a recessed slot. Bake it, export, compress, decode and render through the actual
   runtime material. Resolve coordinate, tangent, channel or lighting mismatches before mass baking.
3. **Freeze the bake inputs.** Finalize topology, normals, triangulation and UVs. Check actual
   raster coverage, overlap and gutters at delivery resolution, including narrow exposed faces.
   A UV layer's existence or a nonzero island bounding box does not establish usable coverage.
4. **Bake and retain masters.** Match parts by stable IDs. Separate neighbors for normal projection
   only when needed; restore stable contacts for AO. Joining HIGH objects can change shaders using
   object coordinates or per-object randomness. Preserve those inputs or bake the parts separately.
   When several parts write one atlas, composite by chart ownership so margins cannot overwrite a
   neighbor. Keep coverage masks distinct from valid black pixels.
5. **Package and decode.** Choose formats by map semantics, importer support and measured error.
   Preserve lossless masters. Read [asset delivery](../../../../skills/vgpu/blender/references/asset-delivery.md).
   Check normals, UVs, materials, hierarchy and animation after the final codec round trip.
6. **Integrate and accept.** Inspect HIGH, unbaked LOW, baked LOW and decoded runtime output at
   matching views where those stages exist. Check lower mips and motion. Measure loading separately
   from steady-state rendering using [the measurement workflow](performance-measurement.md).

Save a checkpoint at each expensive stage. Hash the inputs each stage actually consumes:
geometry/UV/normal changes invalidate dependent bakes; changing an encoder can reuse unchanged
lossless masters. Reopen the saved source in a fresh Blender process and verify image pixels and
bindings survive. A successful packaging retry should not repeat a valid overnight bake.

## Production manifest and acceptance

Keep a versioned manifest beside durable production sources. Use the project's existing schema;
otherwise start with the fields below. A field that does not apply needs a reason, not invented data.

| Field | Required information |
| --- | --- |
| Identity | Schema version, asset ID, source revision/input hashes, source authority, tool versions |
| Runtime contract | Units/axes, part IDs/pivots, UV sets/tangents, material channels/color spaces, animation conventions |
| Stage records | Input/output hashes, command, settings, status and evidence paths for LOW, bakes, packaging and runtime checks |
| Geometry | Evaluated HIGH counts, exported LOW vertices/triangles/primitives per LOD, sharing and bounds |
| Textures | Semantic, UV set, encoding, normal convention, dimensions/mips, loaded GPU format, master/output paths |
| Costs | Download bytes, measured decode/staging costs when available, geometry/texture residency estimates or measurements with method |
| Acceptance | Matching cameras/poses, comparisons, validator coverage, measured errors and separate thresholds, unresolved findings |

For example, a lamp with a rotating arm must preserve the hinge pivot and attached cable across
the full motion. A compact GLB that freezes the cable fails the motion contract. A static crate
has no animation acceptance stage; record that exclusion and verify its visible faces instead.

Validators need nonempty coverage and a known failing input when practical: a contact checker
that visits no joints cannot pass an articulated model. Do not replace measurements with favorable
thresholds, suppress unexplained dark texels, or silently publish only some expected asset families.
Missing required evidence is an incomplete delivery. The final handoff lists artifact paths,
commands, accepted/rejected candidates, reviewed revision and remaining limitations.
