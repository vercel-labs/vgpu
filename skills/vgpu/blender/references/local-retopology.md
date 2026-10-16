# Rebuild topology around local detail

Use this when an opening, vent or recess produces long thin triangles or shading distortions in
the runtime mesh. Retopology means rebuilding the mesh's face layout while preserving the intended
surface. It is not a mandatory all-quad conversion for every asset; runtime meshes are triangulated.

Start by inspecting the final triangulated LOW with maps disabled and a wireframe overlay.
Measure the affected region's triangle count, small angles, longest edges and shading. Narrow
bevel strips may legitimately contain thin triangles; the goal is to remove damaging geometry,
not to satisfy a universal minimum-angle threshold.

1. Bound a patch by existing faces that can be removed completely. Preserve its outer vertices
   and the surfaces that must remain unchanged. Adding a vertex midway along an edge without
   splitting the adjacent retained face creates a T-junction and can produce cracks or bad triangles.
2. Put density around the opening, with real thickness where it is visible. Reduce density toward
   the coarse outer boundary instead of extending every detail edge around the entire object.
3. Preserve creases and attachment surfaces. If using quad strips, plan compatible boundary counts
   before generating them. For example, successive 3-to-1 column reductions remove two columns
   each: 10 → 4 → 2 works, whereas 11 → 2 needs a different transition. This is one construction
   option, not a rule for sculpted or deforming meshes.
4. Project new surface vertices back to the intended source where appropriate. Preserve crease
   vertices and shading normals; use separate normals for recess walls and rims. Check the exported
   triangulation rather than trusting the editing viewport.

For example, cutting several slots into one large panel can create triangle fans stretching
from each slot to distant corners. A locally dense patch around the slots keeps the outer panel
coarse while preserving the slots' silhouette and thickness. Simply applying a decimation ratio
does not establish that result.

Compare matched unbaked renders and final runtime wireframes; check boundaries, contacts and
shading from the closest required view. A closed solid should retain its manifold boundary;
an intentionally open sheet should retain its intended open edges. Rebuild dependent UVs and
bakes after changing their geometry or tangent frame. Preserve the old version for comparison.
