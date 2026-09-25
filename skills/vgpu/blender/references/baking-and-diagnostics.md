# Baking and Diagnostics

## Prepare the final low-poly mesh

The final LOW defines the bake: transforms resolved without breaking rig pivots, clean topology, stable normals, UV seams, and triangulation. Export its tangents or verify equivalent tangent generation in the importer. Revisit affected bakes when this base changes.

Inspect hard, smooth, or weighted normals across flat panels and bevel transitions. Smoothing every face does not repair unsuitable topology. HIGH and LOW need corresponding intended surfaces, not matching vertex counts.

Use stable names or groups to pair parts. An explicit cage must match LOW topology and transforms; an automatic extrusion still needs inspection. Choose projection distances for local thickness, curvature, and nearby surfaces rather than copying a universal offset.

For selected-to-active normal baking, verify the source selection, active LOW, source visibility, active image target in each receiving material, tangent space, and Y convention. Initialize unused normal texels to neutral (0.5, 0.5, 1) and AO to 1. Disable clearing between passes that accumulate into one atlas.

Isolate matched HIGH/LOW pairs when projection picks up adjacent parts. Move an explicit cage with its pair. Use compact, deterministic offsets: extreme coordinates lose precision around narrow bevels. Restore the assembly before export.

## Cap and side normals

For a straight cylinder with flat ends, cap normals point outward along the cylinder axis: opposite directions at the two ends. Smooth side normals point radially outward and have no axial component. Keep a hard shading boundary at each rim; use flat cap faces, sharp rim edges, and split corner normals or separate cap/side vertices. Coincident positions do not imply that their normals should be averaged. Actual bevels have their own transition normals; preserve those deliberately.

Check the final exported mesh after joins, welding, triangulation, axis conversion and import. Inspect cap directions, side-normal axial components, unit lengths and outward orientation. Where the format stores normals per vertex, cap and side triangles must use distinct rim vertices. Avoid a later normal-recalculation or vertex-merge step that removes the crease. Review grazing highlights with maps disabled, then rebake affected maps after correcting normals.

## Bake stable occlusion

Decide which surfaces can occlude one another throughout the expected motion. Preserve permanent contacts within rigid assemblies; avoid imprinting stationary bodywork onto rotating wheels or other changing neighbors. Choose a finite occlusion distance appropriate to the asset. Keep directional lighting and material color out of the AO bake.

Use runtime occlusion for changing environmental contacts. Smooth, low-frequency self-occlusion can use vertex data when mesh density supports it; finer variation may require a texture. Keep emissive or intentionally unshaded features from being darkened unintentionally.

## Texture filtering and runtime conventions

- Normals and AO are linear data. Disable sRGB conversion and avoid premultiplying data channels by alpha.
- Design island padding in pixels of the final resolution. Account for downsampling and mipmaps; more resolution cannot fix overlapping UVs.
- For a downsampled normal master, decode RGB to vectors, average, normalize, and re-encode. Average AO separately as a scalar.
- Choose channels for the actual data and shader. A single AO channel need not occupy an RGBA atlas; packing AO with normals is useful only when sampling and compression requirements are compatible.
- Estimate uncompressed residency as `width × height × bytesPerTexel`, summed over mip levels. A complete square mip chain is approximately 4/3 of its base: RGBA8 2048² is about 21.33 MiB, while R8 1024² is about 1.33 MiB. Account for the actual target format when compressed textures are used.
- Verify texture orientation, axis conversion, and the tangent frame through import. Nonuniform scales need correct normal transforms; mirrored transforms affect handedness and winding.
- Averaged normals can lose length in mipmaps. When specular highlights shimmer, consider filtering and roughness adjustment based on normal variance instead of globally blurring the intended material response.

## Diagnose before changing the bake

| Symptom | Distinguishing check | Possible correction |
| --- | --- | --- |
| Extra highlight or broken edge | Compare HIGH, unbaked LOW, and baked LOW under the same light | Inspect modifier order, bevel scope, and cage before changing the texture |
| Outer bevel clipped only in LOW | Disable secondary bevel modifiers | Restrict them by weights or groups; angle thresholds can select different edges at different densities |
| Patches or cuts on flat faces | Inspect isolated projection and cage coverage | Adjust normals, rays, or the cage; increasing its size may capture neighboring surfaces |
| Detail reverses when rotating or mirroring | Use grazing light, map toggles, and representative transforms | Fix tangent handedness or Y convention instead of arbitrarily inverting channels |
| Seams appear only at a distance | Compare base texture with mip levels | Correct gutters, filtering, precision, or texel density |
| Highlights shimmer during motion | Compare still/moving views and disable the normal map | Make normal filtering and roughness response consistent |
| AO has no visible effect | Compare the real map with neutral AO in the target material | Check the channel, UVs, blend expression, strength, and active material |
| AO slides or becomes excessive | Toggle AO while moving articulated parts | Isolate changing contacts or reduce bake distance and strength |
| Openings or recessed details disappear | Inspect close-ups and rays through the opening | Remove obstructing surfaces and coplanar overlaps |
| Blender and the game disagree | Compare each with maps enabled and disabled | Check lighting, material interpretation, axes, tangent data, and import settings |
| More detail costs more than expected | Compare per-pass draws, resident textures, and GPU timings | Address the measured bottleneck through materials, instancing, culling, LODs, or shadow simplification |

## Choose review coverage for the change

1. Match old and new assets at the actual gameplay camera.
2. Compare HIGH, unbaked LOW, and baked LOW under lighting that exposes surface errors.
3. Inspect edges, seams, openings, and nearby surfaces at close range.
4. Toggle normals and AO independently; use image differences where helpful.
5. Exercise relevant motion, articulation, scales, mirrored transforms, and both sides of LOD thresholds.
6. Check a representative runtime scene with the target renderer; verify resource lifetime when integration changes it.

Scale this review to the edit. Report remaining limits honestly: finite texture resolution remains visible under extreme zoom, and reduced geometry alone does not establish a frame-rate improvement.
