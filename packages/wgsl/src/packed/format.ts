export type PackedScalar = null | boolean | number | string;
export type PackedCell = PackedScalar
  | readonly [node: number]
  | readonly [externalTag: -1, block: number];
export type PackedNode = readonly [shape: number, ...fields: PackedCell[]];
export type PackedTable = readonly [
  version: 1,
  shapes: readonly (readonly string[])[],
  nodes: readonly PackedNode[],
  root: PackedCell,
];

export const PACKED_VERSION = 1;
export const PACKED_LIMITS = {
  tables: 17,
  shapes: 4096,
  nodes: 65536,
  encodedSlots: 1048576,
  expandedValues: 1048576,
  expandedStringUnits: 8388608,
  depth: 128,
} as const;

const PACKED_ERROR_CODE = "VGPU-WGSL-PACKED-METADATA-INVALID" as const;
const PACKED_ERROR_FIX = "Rebuild with compatible @vgpu/wgsl loader assets.";

export function invalidPackedMetadata(reason: string): Error & {
  code: typeof PACKED_ERROR_CODE;
  fix: string;
} {
  return Object.assign(
    new Error(`Invalid packed WGSL metadata: ${reason}. ${PACKED_ERROR_FIX}`),
    { code: PACKED_ERROR_CODE, fix: PACKED_ERROR_FIX },
  );
}
