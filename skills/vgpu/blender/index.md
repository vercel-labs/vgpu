# Blender Assets

Turn authored detail into reproducible assets that read clearly from the intended runtime cameras and have a measured runtime cost. Preserve the approved style, proportions, dimensions, pivots, and behavior unless the user requests changes. Choose geometry density, bevel size, and texture detail for the asset's screen size and art direction.

Use the target project's asset paths, exporter/importer, coordinate conventions, art direction, and performance budgets. These are project inputs, not defaults supplied by this guide. Check the installed Blender version before using version-dependent operators or export options. For vgpu integration APIs, follow the installed-package documentation routing in [the parent skill](../SKILL.md).

Read [shape and assembly](references/shape-and-assembly.md) when designing silhouettes, fitting separate parts, preserving character features, or removing hidden geometry. Read [baking and diagnostics](references/baking-and-diagnostics.md) when preparing UVs and cages or investigating shading artifacts. These references describe transferable decisions, not fixed dimensions or budgets.

## 1. Establish a baseline

- Inspect the supplied references, source mesh, materials, rig, collision shapes, and export/import pipeline before editing.
- Capture the original with the target renderer: gameplay view, front, rear, side, and close-ups of problem areas. Save camera, resolution, lighting, exposure, random seed, and animation state for matching comparisons.
- Preserve the original export and its maps, or a revision that can reconstruct them. A HIGH/LOW viewer measures fidelity; before/after review also needs the actual previous asset.
- Record triangles, exported vertices, draw calls by pass, file size, and resident geometry/texture memory. Identify which costs matter for the intended number of instances and target hardware.
- Label generated concepts as concepts. Validate implemented geometry with actual model renders.

## 2. Choose how to represent detail

| Requirement | Suitable representation |
| --- | --- |
| Silhouette, visible openings, broad edges, articulated parts | Actual low-poly geometry |
| Fine bevel curvature and relief with little silhouette impact | Tangent-space normals baked from a high-poly source |
| Persistent cavities and contacts within a rigid assembly | Baked ambient occlusion (AO) |
| Changing contacts between moving parts and directional shadows | Runtime lighting or shadows |
| Repeating surface grain or microtexture | A reusable material layer with its own scale |

Do not default to uniformly decimating a high-poly mesh. Shared profiles, deliberate retopology, and region-specific sampling can preserve hard-surface shapes, pivots, and openings more efficiently. A simple prop may need only authored low-poly bevels and AO; create a high-poly source or normal map only when it adds useful detail.

## 3. Keep authoring reproducible

- Work on a copy or a new scene. Separate source, high-poly (HIGH), low-poly (LOW), cages, and review staging so export and bake inputs remain unambiguous.
- Retain an editable source. For procedural assets, expose dimensions, radii, segment counts, and seeds; inspect existing scripts for scene-clearing or export side effects before reusing them. Keep part identifiers, axes, and origins compatible with the target rig.
- Build HIGH for the detail that will transfer. In LOW, remove buried surfaces and invisible inner layers first; distribute vertices by curvature and visibility, including rear views, transparency, and motion.
- Check assembly contacts on the exported LOW. Reduced sampling must not detach edges, supports, or fasteners that are meant to touch.
- Finalize transforms, modifiers, normals, UVs, and triangulation before baking. Keep the bake and runtime tangent basis consistent. Rebake affected maps after changing this base.
- Preserve intended shading creases: flat cylinder caps must not share smoothed normals with their side walls. Verify the exported normals after joining and triangulating; see [cap and side normals](references/baking-and-diagnostics.md#cap-and-side-normals).
- Review HIGH and LOW without maps first. A normal map cannot fix a malformed silhouette, close a gap, or undo an unintended bevel modifier.

## 4. Bake and package

- Use bake UVs without accidental overlap, with density allocated to visible surfaces and sufficient padding at the final resolution. Keep reusable microdetail UVs separate where needed.
- Control HIGH-to-LOW projection through matched parts and suitable cages. When neighbors contaminate a normal bake, temporarily separate matched HIGH, LOW, and cage sets by the same compact offsets, then restore the assembly.
- Bake AO with physically meaningful grouping. Preserve stable contacts and avoid baking changing occlusion onto moving parts. Do not automatically reuse an exploded normal-bake arrangement for AO.
- Treat normals and AO as linear data. Match texture orientation, tangent handedness, and normal-map Y convention across tools. In physically based materials, apply AO to indirect illumination; make any stylized use explicit.
- Choose resolution, padding, channels, and compression for the target camera and platform. Downsample normal masters by decoding, averaging, and renormalizing vectors; filter AO as a scalar. File compression alone does not reduce resident GPU memory.
- Package runtime meshes and maps separately from HIGH, cages, and bake masters. Record source revision, units, axes, dimensions, counts, texture channels, and bake settings. Keep the editable source or generator outside disposable scratch storage.

## 5. Integrate within the runtime budget

- Reuse compatible materials, loaders, and shared resources. Convert axes and units once, preserving normal and tangent transforms through articulation and nonuniform scaling.
- Share geometry and textures across repeated instances where possible. Account separately for material slots, transparency, shadow passes, and per-instance animation data.
- Use instancing and spatial batches with correct bounds for repeated props. Add LODs where their savings justify the extra assets; verify switching thresholds and any intentional crossfade cost.
- Consider a simpler shadow mesh when small details do not affect the shadow silhouette. Validate it in the real shadow pass.
- Check target-platform vertex layouts and buffer limits; attribute count alone may not describe the physical buffer layout.
- If animation is part of the change, tune it at actual gameplay distances and speeds. Prefer existing rigid pivots for rigid motion, and verify animated bounds, shadows, dependent motion, and animation priorities. See [motion readability](references/shape-and-assembly.md#motion-readability).

## 6. Verify the observable result

Compare the original, HIGH, unbaked LOW, and baked LOW under matched conditions where those versions exist. Review at close range and gameplay distance, from behind and during movement. Toggle normal maps and AO to confirm their visible contribution; a loaded texture does not prove the material uses it.

Use focused checks for fragile asset contracts: dimensions and pivots, finite UVs and tangent frames, unobstructed openings, assembly contacts, resource sharing, and animation/LOD bounds. Compare instanced or batched rendering with individual meshes when changing those paths. Inspect mip seams, unstable highlights, renderer errors, and resource lifetime when relevant.

Validate integration in a representative runtime scene using the actual materials and lighting. An isolated viewer or successful import cannot establish that the application renders the asset correctly.

Measure before and after with the same scene and settings. Report geometry, material, texture, and shadow costs separately. Do not infer an FPS improvement from triangle counts alone or certify a frame-rate target from a capped or isolated sample.

Deliver the requested asset work with reproducible sources, a real comparison, export/bake instructions, measured costs, and remaining limitations. Keep implementation and integration within the user's requested scope.
