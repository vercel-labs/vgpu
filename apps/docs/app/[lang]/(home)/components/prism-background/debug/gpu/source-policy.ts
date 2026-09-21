import type { PrismDebugSourceId } from "../sources";

const STATIC_SOURCES = new Set<PrismDebugSourceId>(["raw-caustic"]);

export function isStaticPreview(id: string): boolean {
  return STATIC_SOURCES.has(id as PrismDebugSourceId);
}
