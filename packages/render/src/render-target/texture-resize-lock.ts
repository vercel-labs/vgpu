import type { Texture } from "@vgpu/core";

const textureResizeLock = Symbol.for("vgpu/Texture/resizeLock");
const RENDER_TARGET_RESIZE_LOCK = "Texture is captured by a renderTarget() snapshot; recreate the render target instead of resizing (resizable render targets are a planned follow-up).";

type ResizeLockableTexture = Texture & Record<symbol, ((reason: string) => void) | undefined>;

export function markTextureCapturedByRenderTarget(texture: Texture | undefined): void {
  (texture as ResizeLockableTexture | undefined)?.[textureResizeLock]?.(RENDER_TARGET_RESIZE_LOCK);
}
