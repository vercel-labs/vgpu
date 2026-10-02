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

Inventory spatial material variation stored in vertex or corner attributes before reducing them. Interpolating those attributes through simplification can erase fine color, weathering or roughness patterns even when the remaining geometry and projected normals are valid. Compare HIGH and LOW with an unlit attribute visualization; bake required fields into a supported texture domain or retain enough geometry to carry them. Include those extra maps, channels and sampling costs in the optimization budget.

A small feature's approximate projected extent near the view center is `pixels ≈ length × viewportHeight / (2 × cameraDepth × tan(verticalFov / 2))`. Use consistent units and the feature's projected length, not an ambiguous radius. This is a prioritization heuristic, not a universal deletion threshold: highlights, motion, antialiasing, oblique views and other cameras can make a small feature important.

Use per-region targets and compare actual output. Do not retain every original UV split merely to reuse an atlas if that defeats the reduction; allow a new LOW layout and rebake. Conversely, do not regenerate unaffected material tiles when their dependencies remain identical.

Protect the shading neighborhood as well as the feature's triangles when exact source shading must survive reduction. Collapsing adjacent faces can change a preserved corner's custom-normal basis even when its position and winding stay identical. Preserve the necessary incident faces, then compare decoded normals and consumed attributes after simplification and a fresh reopen. Reassigning the old normal vectors can introduce quantization error in the changed basis; verify the result instead of assuming the setter preserves them exactly.

## 3. Freeze the receiving surface and its frames

Finalize LOW topology, applied transforms, shading normals, UVs and deterministic triangulation before projecting. The triangulation used by the baker must be the one exported. Verify the serialized result, including any splits or reorderings made by the exporter; a modifier label alone is not proof.

Use the frozen, serialized frame for checkpoint identity and decoding. Keep per-field hashes so a resume failure identifies whether positions, topology, normals, UVs or tangents changed. Recomputed floating-point tangents can differ slightly between processes; compare that diagnostic against the frozen frame with an explicit precision limit instead of substituting its hash for the asset identity. Reopen independently and require exact equality of the canonical fields; do not round away a real source change.

Check LOW face orientation against the intended HIGH surface before casting rays. A reconstructed profile can match positions while reversing face winding, especially when the original generator corrected orientation in a later stage. Preserve corner/UV correspondence when repairing winding; do not try to compensate with cage distance or a flipped normal-map channel.

A nearest-triangle normal is not sufficient proof of reversed winding on a simplified rock or sculpt. Near creases, folds and thin surfaces, multiple nearby HIGH triangles can face different directions. Inspect shared-edge winding, component orientation and the intended projection correspondence before reversing faces. A coherent closed mesh can still have projection problems; diagnose those with the actual cage and covered-texel oracle rather than forcing every nearest-normal dot product positive.

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

Keep projection directions separate from the shading frame. A CPU witness that averages geometric face normals can disagree with the baker when custom normals are present: Blender 5.0's vertex-normal path can mix custom corner normals. Read and serialize the native derived normals needed by the projection, bind them to the frozen mesh identity, and verify their reload independently. If reconstructing them for a diagnostic, compare against the native values with an explicit tolerance; do not silently substitute a different normal provider. [Blender 5.0 normal evaluation](https://github.com/blender/blender/blob/v5.0.0/source/blender/blenkernel/intern/mesh_normals.cc).

If a preserved part has a unique, exact correspondence between its directed HIGH and LOW triangles, geometric normals can be transferred through that correspondence instead of casting rays across a thin surface. Prove positions, winding and corner alignment; reject ambiguous or reversed matches. Interpolate the actual HIGH corner normals at the receiver samples and encode them in the frozen LOW frame, then independently decode and compare every covered sample. Equal geometry does not imply identical exported normals or justify filling a neutral map. Label analytic coverage separately from measured ray hits, and retain the ordinary projection path for changed parts. This shortcut does not establish AO or illumination dependencies.

Compare HIGH, LOW with projected normals disabled, and baked LOW under the same grazing light/camera. The bake should recover a visible, known removed feature. Also test a neutral map and directional +X/+Y witnesses through the real shader; a loaded texture or a CPU vector test alone cannot prove the frame/sign convention.

For focused VGPU checks, use `vgpu/node` in project-owned scripts to render isolated components or shader fixtures into offscreen targets and read back PNGs or numeric results. Reuse the production WGSL, asset decoding and material bindings; a separate approximate shader does not validate the application. Keep diagnostic fixtures and probe entry points outside the shipped application. Record the actual adapter, inputs and errors, then use browser captures for the complete scene, interaction and browser-specific behavior.

For a difficult frame mismatch, bake an object-space normal reference and an explicit source-hit mask with the same projection settings. Compare decoded tangent normals against that reference on covered texels, separating chart-boundary filtering from interior errors. Include a smooth curved receiver; flat charts alone cannot test interpolation parity. Inspect error outliers rather than hiding them in a mean or relaxing the threshold.

That comparison verifies decoding, not source selection: both normal passes can hit the same unintended surface and still agree. Check the intended source part or region independently, for example with a constant source-face ID diagnostic under the same projection settings. Inspect unexpected source locations and distances, especially through thin or concave geometry. Complete coverage and a small normal-decoding error do not establish correct correspondence.

Match the baker's raster sampling before diagnosing a projection or frame error. Blender 5.0's [`RE_bake_pixels_populate`](https://github.com/blender/blender/blob/v5.0.0/source/blender/render/intern/bake.cc) offsets receiver samples to `(x + 0.501, y + 0.502)`; assuming exact pixel centers can misidentify the triangle at an edge and distort normal comparisons on narrow charts. Pin such implementation details to the executed version and independently verify coverage and triangle ownership. A sampled EMIT pass can identify constant face IDs, but its averaged barycentrics need not match the receiver weights used for tangent conversion ([Cycles bake sampling](https://github.com/blender/blender/blob/v5.0.0/intern/cycles/kernel/integrator/init_from_bake.h)). Retain every actually covered texel; do not hide a mismatch by eroding the comparison mask.

Keep coverage diagnostics undilated: filled padding can turn a miss into an apparent hit or mix border values from a different frame. Produce delivery gutters as a separate verified step and compare covered samples before/after padding. A diagnostic with zero margin is not a finished, mip-safe delivery texture.

Before dropping normal Z to deliver two channels, verify that the intended samples lie in the positive-Z hemisphere. Negative Z may reveal opposite-side projection on a thin part, an unsuitable receiving surface, or a legitimate encoding requirement. Fix the projection/LOW where appropriate, or use an encoding that preserves the required hemisphere; reconstructing positive Z silently changes those normals.

A double-sided material does not make opposite-side projection harmless. Opposite winding and opposite vertex normals can produce the same unperturbed surface normal while changing a derivative-based material normal layer. Compare front and back views with tiled and projected layers independently enabled through the actual shader before treating the two orientations as equivalent. A synthetic plane establishes shader behavior; it does not prove a correspondence or repair on the asset.

## 5. Bake occlusion and illumination deliberately

Do not automatically use the isolated/exploded normal-bake scene for AO. Restore permanent neighbors and use the intended assembled occluder set and distance. For a transfer bake, record whether occlusion is evaluated on the HIGH surface and projected to LOW, or evaluated directly on LOW; those produce different detail. Avoid duplicate LOW/HIGH proxy surfaces unintentionally self-occluding.

Keep AO separate from the normal vector and from baked directional illumination. Channel packing is possible when the decoder, UVs, filtering and precision explicitly support it; attenuating a normal vector is not an AO model. Compose AO according to the renderer's declared indirect-lighting contract.

Changing receiver geometry, normals, UVs or triangulation invalidates dependent unique AO and lightmaps. Recompute affected passes or prove their dependencies unchanged. Preserve an accepted HIGH delivery's own maps and hashes. Do not attach old lightmaps to new UVs or relabel them with a new identity.

When transferring freshly baked HIGH fields through a surface correspondence, validate the source sampling footprint, not only the projected UV coordinate. A chart can have positive area but no rasterized texels, or too few same-chart taps for bilinear filtering. Padding from a neighboring chart is not valid source lighting. Keep these misses explicit; increasing projection distance cannot repair missing source samples.

For an exactly corresponding preserved part, one recovery is an additional HIGH bake UV layer mapped to the LOW receiver domain. Keep original UVs, material coordinate inputs and the assembled occluder geometry intact; select the additional layer explicitly for baking. Before AO or indirect passes, run an undilated coverage/face-ID witness to prove every required receiver sample shades the intended HIGH polygon, unrelated faces cannot write the target, and implicit material UVs still equal the original render UVs. Blender 5.0 exposes the explicit `uv_layer` bake override ([implementation](https://github.com/blender/blender/blob/v5.0.0/source/blender/editors/object/object_bake_api.cc)); verify that behavior in the executed version. Record the auxiliary domain separately from original HIGH UVs. Coverage success alone does not validate lighting, delivery gutters or mips.

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
