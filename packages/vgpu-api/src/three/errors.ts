export type TslExportsErrorCode =
  | "VGPU-THREE-TSL-EXPORT-NOT-FOUND"
  | "VGPU-THREE-TSL-EXPORT-AMBIGUOUS"
  | "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED"
  | "VGPU-THREE-TSL-SOURCE-INVALID";

export function adapterError(
  code: TslExportsErrorCode,
  message: string,
): Error & { readonly code: TslExportsErrorCode } {
  return Object.assign(new Error(message), { code });
}
