import type { Draw, Effect, Target } from "vgpu";

type Drawable = Draw | Effect;
type State = "pending" | "ready" | "failed";

/** Keeps debug pipelines asynchronous so opening the graph never cold-blocks a frame. */
export function createPreviewCompileCache(
  onReady: () => void,
  onError: (error: unknown) => void
) {
  const states = new WeakMap<object, Map<GPUTextureFormat, State>>();
  return {
    ready(drawable: Drawable, output: Target): boolean {
      let formats = states.get(drawable);
      if (!formats) {
        formats = new Map();
        states.set(drawable, formats);
      }
      const state = formats.get(output.format);
      if (state === "ready") return true;
      if (state === "pending" || state === "failed") return false;
      formats.set(output.format, "pending");
      void drawable
        .compile({ colors: [output.format] })
        .then(() => {
          formats!.set(output.format, "ready");
          onReady();
        })
        .catch((error) => {
          formats!.set(output.format, "failed");
          onError(error);
        });
      return false;
    },
  };
}
