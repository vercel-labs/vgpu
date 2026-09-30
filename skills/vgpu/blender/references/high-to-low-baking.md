# Transfer a dense source to a lower-density mesh

Use this procedure when reducing an existing detailed model while retaining its appearance with projected normals and AO. Follow [baking diagnostics](baking-and-diagnostics.md) for artifact checks, [preflight](preflight-and-recovery.md) for expensive stages and [delivery](asset-delivery.md) for codecs and memory. An existing tiled normal texture is not evidence that removed geometric detail was transferred.

## 1. Preserve the actual reference

Keep the approved dense mesh, materials and maps as HIGH. Save a revision and hashes; make a separate LOW candidate. Preserve an editable source or reproducible generator as well as the delivered mesh. An ignored local checkpoint is not a remote backup.

Compare the evaluated source against the current delivered asset. Hidden authoring collections, disabled modifiers or older construction pieces can differ from the visible export. Count evaluated triangles and exported vertices after attribute splits; an edit-mode vertex count can severely understate runtime density. Report density by material and connected part/family before selecting an optimization.

Check that the source collection participates in the evaluated dependency graph before trusting modifier counts. A tiny known beveled part should show its expected additional geometry. Change visibility only in the working copy; an inventory that silently measures the base cage can misidentify the entire cost distribution.

Record matched target views and a baseline wireframe. Wireframe brightness is a diagnostic, not a performance measurement: measure solid-render geometry, passes, texture residency and timings separately.

## 2. Allocate geometry by visible effect

| Feature | First candidate | Required check |
| --- | --- | --- |
| Flat internal tessellation | Dissolve or rebuild a simple surface | Preserve openings, plane boundaries, normals and UV correspondence |
| Small bevels and shallow relief | Reduce bevel/contour segments and project shading detail | Grazing highlights, mip stability, silhouette and closest view |
| Large curved edges, thin supports, holes, steps | Retain sufficient geometry | Parallax, sky silhouette, contact, cast-shadow shape and rear views |
| Repeated trim or disconnected blocks | Simplify the source profile per family; consider instancing | Assembly variation, unique bake UVs and actual exported vertex savings |
| Rock/sculpted surface | Region-weighted simplification or retopology | Shoreline/boundaries, local surface distance, silhouette and important creases |

Normal maps change shading inside the remaining surface. They cannot restore a removed opening, displaced silhouette, geometric parallax or cast-shadow contour. AO describes occlusion; it does not restore that geometry either. Avoid using darker AO to hide an overly aggressive reduction.

A small feature's approximate projected extent near the view center is `pixels ≈ length × viewportHeight / (2 × cameraDepth × tan(verticalFov / 2))`. Use consistent units and the feature's projected length, not an ambiguous radius. This is a prioritization heuristic, not a universal deletion threshold: highlights, motion, antialiasing, oblique views and other cameras can make a small feature important.

Use per-region targets and compare actual output. Do not retain every original UV split merely to reuse an atlas if that defeats the reduction; allow a new LOW layout and rebake. Conversely, do not regenerate unaffected material tiles when their dependencies remain identical.

## 3. Freeze the receiving surface and its frames

Finalize LOW topology, applied transforms, shading normals, UVs and deterministic triangulation before projecting. The triangulation used by the baker must be the one exported. Verify the serialized result, including any splits or reorderings made by the exporter; a modifier label alone is not proof.

Check LOW face orientation against the intended HIGH surface before casting rays. A reconstructed profile can match positions while reversing face winding, especially when the original generator corrected orientation in a later stage. Preserve corner/UV correspondence when repairing winding; do not try to compensate with cage distance or a flipped normal-map channel.

Allocate unique nonoverlapping UVs for the projected detail and baked occlusion. Pick texel density from the closest required view, with space for seams and mip gutters. Reusable surface detail may retain a separate tiled UV set. Check exposed narrow regions at raster resolution rather than accepting positive UV area alone.

Hard shading boundaries often need separate padded bake charts so filtering does not blend unrelated tangent-space vectors. Treat hard edges, UV seams and cage connectivity as separate decisions. Do not make all normals smooth just to avoid seams, or assume every seam needs a hard edge.

For each normal layer record:

- receiving mesh/triangulation and normal identity;
- UV set, transforms, handedness, normal Y convention and encoding;
- how its tangent frame is generated, exported, transformed and interpolated;
- whether it contains geometric transfer, tiled material detail, or both.

For glTF, the primary normal texture identifies its UV set; when tangents are absent the specification recommends MikkTSpace generation from that texture's coordinates. An exported `TANGENT` must match the baked map's frame. A per-fragment derivative frame is not automatically equivalent to the baker's interpolated MikkTSpace frame.

Interpolation and normalization order are part of that contract. An otherwise plausible orthonormalized decoder can disagree with the actual bake on a curved receiver. Use the object-space oracle below to establish the required decoder rather than assuming that a synthetic frame test proves baker parity.

### Two UV sets need an explicit layering contract

Do not sample a unique projected map with tiled UVs, or reuse the tiled map's tangents for the unique atlas. Do not blend two sampled tangent-space vectors as though their differently oriented frames were the same.

Choose a supported path: bake one combined normal map at sufficient density, or retain independent geometric and tiled layers with a verified composition method. A combined bake can lose tiled microdetail or require excessive texture memory. Independent layers require their own correct frame handling and an importer/shader contract; core glTF's single normal slot does not define an arbitrary second layer.

Surface-gradient composition is one established approach to layers with different parameterizations; it still needs correct frames and treatment of near-tangent normals. Exported primary bake tangents plus a separately constructed detail frame is another implementation decision to test, not a blanket recipe. Follow the target renderer's actual implementation and test mirrored, rotated and seam-adjacent charts.

When baking only geometric transfer, remove material bump/normal contributions from the HIGH bake shader so the runtime does not apply the same microdetail twice. When baking a combined map, record that choice and do not layer those details again. Work on bake materials/copies so the preserved source appearance is unchanged.

## 4. Prove one representative transfer

Before a whole-scene bake, select a part that exercises the difficult cases: a beveled edge, an inset/neighboring surface, a curved region and relevant UV orientations. Use the final exporter and runtime material path, not only a flat bake plane.

1. Match HIGH/LOW parts by stable identity and transform. Explicitly select source objects and make LOW active. Set the receiving image node active in every participating LOW material.
2. Initialize a lossless normal target to neutral and AO to unoccluded values. Do not assume every missed ray produces those defaults. Use an explicit coverage/hit diagnostic to distinguish an unhit pixel from genuinely neutral detail.
3. Choose an explicit cage or an automatic extrusion/ray-distance mode for local thickness and relief. An explicit cage must preserve LOW correspondence/topology while enclosing the intended source. Inspect concave/thin areas; inflating more can hit the opposite wall or a neighbor.
4. Confirm the installed Blender version's settings. Cycles exposes Max Ray Distance for selected-to-active without a cage; do not treat it as an independent universal limit for every cage mode.
5. Isolate matched parts for normal projection when neighboring geometry contaminates rays. Keep HIGH, LOW and cage aligned through the same compact transform. Restore the assembly afterward.
6. Bake, export, reload, encode/decode the delivery map, and inspect an actual target-renderer frame before scaling the process.

For joined batches, a bounding box is only a candidate search: neighboring ornament can fall inside it. Pair connected components or stable face identities and compare transformed geometry/topology with a recorded tolerance. Extra vertices in the search region do not alone establish source drift; distinguish contamination from an actual changed component before rebuilding anything.

Compare HIGH, LOW with projected normals disabled, and baked LOW under the same grazing light/camera. The bake should recover a visible, known removed feature. Also test a neutral map and directional +X/+Y witnesses through the real shader; a loaded texture or a CPU vector test alone cannot prove the frame/sign convention.

For a difficult frame mismatch, bake an object-space normal reference and an explicit source-hit mask with the same projection settings. Compare decoded tangent normals against that reference on covered texels, separating chart-boundary filtering from interior errors. Include a smooth curved receiver; flat charts alone cannot test interpolation parity. Inspect error outliers rather than hiding them in a mean or relaxing the threshold.

Keep coverage diagnostics undilated: filled padding can turn a miss into an apparent hit or mix border values from a different frame. Produce delivery gutters as a separate verified step and compare covered samples before/after padding. A diagnostic with zero margin is not a finished, mip-safe delivery texture.

Before dropping normal Z to deliver two channels, verify that the intended samples lie in the positive-Z hemisphere. Negative Z may reveal opposite-side projection on a thin part, an unsuitable receiving surface, or a legitimate encoding requirement. Fix the projection/LOW where appropriate, or use an encoding that preserves the required hemisphere; reconstructing positive Z silently changes those normals.

## 5. Bake occlusion and illumination deliberately

Do not automatically use the isolated/exploded normal-bake scene for AO. Restore permanent neighbors and use the intended assembled occluder set and distance. For a transfer bake, record whether occlusion is evaluated on the HIGH surface and projected to LOW, or evaluated directly on LOW; those produce different detail. Avoid duplicate LOW/HIGH proxy surfaces unintentionally self-occluding.

Keep AO separate from the normal vector and from baked directional illumination. Channel packing is possible when the decoder, UVs, filtering and precision explicitly support it; attenuating a normal vector is not an AO model. Compose AO according to the renderer's declared indirect-lighting contract.

Changing receiver geometry, normals, UVs or triangulation invalidates dependent unique AO and lightmaps. Recompute affected passes or prove their dependencies unchanged. Preserve an accepted HIGH delivery's own maps and hashes. Do not attach old lightmaps to new UVs or relabel them with a new identity.

## 6. Scale, review and deliver

Checkpoint LOW preparation, geometry/UV validation, projection, AO/illumination, export, packaging and runtime acceptance independently. Record actual inputs, evaluated geometry, cage parameters, render engine/device, samples, resolution, margins, seed and output hashes. Recover a packaging failure without repeating valid bakes.

A saved `.blend` alone does not prove the baked pixels survived. Save lossless masters, then pack the required images or bind explicit saved files with the correct color space and retained users. Setting `filepath_raw` on a generated image is not a persistence check. Reopen the checkpoint in a fresh process and compare its loaded pixels and bindings against the saved masters; unused images can disappear and generated buffers can reset.

Review full matched hero/rear/close views as well as defect crops. Inspect grazing angles, stairs/openings, contacts and silhouettes, then move the camera and cross LOD thresholds. Toggle projected normals, tiled normals, AO and lightmaps independently when those are separate terms. Inspect lower mips and compressed output too.

Report triangles **and exported vertices**, primitive counts, download bytes, GPU vertex layout and texture residency before/after. Added tangents, duplicated UV charts or larger atlases can offset savings. Lower triangle counts alone do not establish a frame-time improvement.

Keep HIGH accessible/recoverable and promote LOW with its matching maps and manifest only after both visual and structural checks pass. Record rejected candidates and remaining limitations rather than treating a numeric reduction target as visual acceptance.

## Primary references

- [Blender 5.0 Cycles baking](https://docs.blender.org/manual/en/5.0/render/cycles/baking.html): selection, receiving targets, cages, ray settings and margins; verify against the installed version.
- [Blender Decimate modifier](https://docs.blender.org/manual/en/5.0/modeling/modifiers/generate/decimate.html): reduction modes and delimiters, not automatic appearance acceptance.
- [glTF 2.0 specification](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc): normals, texture coordinates and tangent conventions.
- [Khronos NormalTangentTest](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/NormalTangentTest) and [NormalTangentMirrorTest](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/NormalTangentMirrorTest): concrete normal/frame diagnostic assets.
- [Surface Gradient-Based Bump Mapping Framework](https://jcgt.org/published/0009/03/04/) and [author's reference implementation](https://github.com/mmikk/surfgrad-bump-standalone-demo): normal layers with multiple parameterizations.
