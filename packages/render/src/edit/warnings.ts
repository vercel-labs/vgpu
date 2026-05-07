export type MeshEditWarningCode = "NON_MANIFOLD_EDGE_SKIPPED" | "NON_MANIFOLD_VERTEX_SKIPPED" | "DEGENERATE_FACE_DROPPED" | "TANGENTS_STRIPPED" | "BEVEL_ACUTE_CLAMPED" | "INSET_OVERLAP_CLAMPED" | "SEAM_DESTROYED" | "BRIDGE_LOOP_LENGTH_MISMATCH" | "FILL_NON_PLANAR_BOUNDARY" | "LOOP_CUT_AMBIGUOUS_CONTINUATION" | "FILL_HOLE_TRIANGULATED" | "GRID_FILL_TRIANGULATED";
export class MeshEditWarning {
  constructor(readonly code: MeshEditWarningCode, readonly reason: string, readonly element?: { readonly domain: "vertex" | "edge" | "face"; readonly index: number }) {}
}
