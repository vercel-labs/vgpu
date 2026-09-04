/** Entry names consumed only by the opt-in GPU preview bridge. */
export const LIGHT_WALL_DEBUG_ENTRIES = Object.freeze({
  "wall-material": "fs_albedo",
  "wall-normal": "fs_normal",
  "wall-roughness": "fs_roughness",
  "global-shadow": "fs_global_shadow",
  "prism-ao": "fs_prism_ao",
  "composed-wall": "fs_composed",
} as const);

export const LIGHT_CAUSTIC_DEBUG_ENTRY = "fs_raw_caustic";
