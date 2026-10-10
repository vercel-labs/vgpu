# Shape, Assembly, and Motion

Apply these principles to the intended art direction and camera coverage. Dimensions, sampling density, and motion amplitudes belong to the individual asset, not to a universal preset.

## Resolve the profile before baking

If HIGH and LOW share the same spike or bulge, inspect their common profile before increasing subdivisions or changing normals. At a dome's apex, check tangent continuity: a conical transition remains pointed even with more polygons. Evaluate side silhouettes without maps and with a neutral material.

An outer panel need not inherit every curve of the body underneath. For example, a shield can wrap horizontally while remaining straight between its upper and lower boundaries. Encode the intended shape directly rather than offsetting the supporting surface everywhere.

## Give separate parts believable attachment

- Separate parts to express construction, material, or articulation, and define their support surfaces. A constant stand-off from a body can leave mounting edges floating.
- Preserve clearance where needed and taper it toward attachment points. Move fasteners, rings, and supports with the fitted part.
- Inspect both sides, the rear, and grazing views. Measure contact on the exported LOW: coarse facets can open a joint that appeared closed in HIGH.
- Include wall thickness when interpreting an exterior gap. Where appropriate, allow a small controlled overlap in buried areas; avoid coplanar surfaces that cause z-fighting. Choose tolerances for the asset's scale and silhouette.
- For a fragile attachment, check rays or distances against the actual export at several positions, alongside visual review. A test that merely repeats the generator formula does not validate the exported assembly. Rebake when the LOW's geometric basis changes.

## Build architectural relationships together

For repeated architecture, derive openings, piers, trim and roof supports from shared bay boundaries and named attachment surfaces. Join adjoining parts at their actual profiles: for example, connect a wall body to a pillar shaft, and its wider top cap to the pillar's wider cap. Extending every layer to the same plane can leave a slot or buried faces. Remove covered faces and share boundary edges where appropriate; preserve deliberate UV seams and hard-normal splits. Joining objects alone does not remove overlapping or internal faces.

Check the mesh after modifiers and the exported result, not just a generator parameter whose code path may be unused. Resolve stairs and landings as a continuous route with real treads and risers: verify tread/riser consistency, endpoint heights, usable landing depth and their actual connections at the intended scale before adding wear or decoration.

When clearing an opening, identify which faces may move and which outer corners, wall junctions and silhouette edges must stay fixed. Shrinking a support symmetrically can expose buried ornaments, open a corner slot or hide its cap inside the roof. Inspect both adjoining walls, cap projection and the support beneath attached decorations after the repair.

Survey all nearby parallel faces before choosing a clearance. An arbitrary small offset can fix one coplanar pair while landing on another. Measure gaps and obstruction against evaluated and exported LOW meshes at every delivered LOD, with scale-appropriate tolerances.

Check boundaries meant to remain closed separately from routes meant to remain open. For example, a landing needs a continuous outer guard while its stair entrance stays clear. Inspect the full outer edge from above, outside and at grazing angles; use ray or distance checks at multiple joins on the actual export, then check the entrance for obstructions. Two individually closed guard blocks can still leave a gap between them. A few successful rays do not certify the whole boundary. Report unresolved intersections outside the repaired area explicitly.

## Preserve identity and proportions

When resizing a group of facial features, scale both their dimensions and their center-to-center distances about a common center. Shrinking each feature about its own origin preserves absolute spacing and can change the expression. Compare normalized proportions and spacing against the approved reference.

Measure evaluated dimensions after parent transforms and export. Nonuniformly compressing a head or housing can distort features that should retain their proportions. Keep planar features on an independent interior plane when the design calls for it, instead of conforming them to a curved shell. Recessed supports should meet the backs of the features and terminate behind the surrounding body without exposing a floating plate from the side.

## Reduce geometry by visible surface

Choose whether each part family needs separate geometry before simplifying its polygons. Joining objects alone retains their component topology. Preserve silhouette, visible depth and parallax, deformation or articulation, and required UV or shading boundaries. Use the target views to choose among these candidates:

| Candidate | Treatment |
| --- | --- |
| Flat floors made of individual tiles | Rebuild a continuous surface; bake joints, small bevels and wear or use reusable procedural/material detail |
| Repeated masonry blocks | Use a continuous wall where individual blocks do not affect visible depth, openings or silhouette |
| Deck boards | Retain visible gaps and exposed thickness; transfer small bevels to normals where the target views permit |
| Subdivided window glazing | Prefer one glass surface per window with minimal separate bars; preserve required thickness, layered glazing or independent movement |
| Stair detail | Keep required tread/riser geometry and route shape; transfer small wear and relief to the material |
| Duplicate inner walls, rear fastener caps, buried faces | Remove if no required view, transparency, articulation, or shadow reveals them |
| Openings with visible depth | Preserve local thickness and required backing without rebuilding an entire inner shell |
| Surface straight between two contours | Use endpoint rows and stitch boundary vertices where a neighboring piece needs more subdivisions |
| Partly buried trim | Model the exposed section while preserving corners and curvature changes along its path |
| Detailed regions beside simple curved regions | Vary density by region while retaining rings and edges that support the silhouette |

For example, a flat rectangular floor built from 100 tile boxes can become one continuous surface with tile joints and small bevels in a baked normal map or procedural material. Keep geometry for raised tiles, holes or exposed edges that affect the required views. Joining the 100 boxes into one object still leaves their side and bottom faces. In the solid wireframe review, the simplified floor should no longer have edges around every painted joint; any remaining cuts should serve the floor shape or its attributes.

A geometrically simple region may still dominate the gameplay silhouette. Smooth normals and baking recover shading, but cannot round a polygonal contour or close holes. For substantial reductions, compare silhouette masks from multiple relevant orientations. Review the [solid wireframe overlays](../index.md#6-verify-the-observable-result) and justify remaining subdivisions by their visible, structural or shading role, rather than a universal triangle quota.

Track geometry, material, and texture costs separately. Removing hidden faces can save vertices and triangles while leaving draw calls and atlas residency unchanged. Stop reducing a required silhouette when further savings become visible; a distance LOD may be the better next step.

## Make comparisons useful

Use the previous export with its own maps for before/after review. Synchronize orbit, zoom, lighting, and pose; allow side and rear inspection. Keep HIGH/LOW fidelity review distinct from old/new design review. Make temporary baselines recoverable from durable sources, and exclude heavy review references from normal runtime loading.

Use actual runtime materials for the integration check. Physical transmission in a viewer and simplified transparency in a game can look different on identical geometry. Blender renders alone do not establish the final appearance.

## Motion readability

- Tune gestures, activation thresholds, and vibration for screen size and normal gameplay conditions. Movement that reads clearly in a close-up may disappear at gameplay distance.
- Consider the combined latency of explicit delays, engagement ramps, and spring smoothing. Choose their combination intentionally; review onset, settling, direction changes, and release.
- For rigid motion, prefer existing pivots and transforms over vertex deformation or extra moving parts. Keep shadows aligned, preserve dependent animation, and respect animation priorities.
- Keep cosmetic movement separate from gameplay physics unless behavior changes are requested. For replay or scrubbing, use recorded state or a time-based evaluation that reproduces the same pose independently of previously visited frames. Check frame-rate variation and reduced-motion behavior where supported.
