import { WALL_GLOBAL_LIGHT_MASK_URL } from "./manifest";

let pendingMask: Promise<Blob> | undefined;

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);
  return response.blob();
}

/** Shares theme-aware early fetches with the texture loader. */
export function loadPreloadedWallMask(): Promise<Blob> {
  if (pendingMask) return pendingMask;
  pendingMask = fetchBlob(WALL_GLOBAL_LIGHT_MASK_URL).catch(
    (error: unknown) => {
      pendingMask = undefined;
      throw error;
    }
  );
  return pendingMask;
}

export function preloadLightAssets(): void {
  void loadPreloadedWallMask().catch(() => {
    // The GPU bake has a fully procedural fallback if the mask is unavailable.
  });
}
