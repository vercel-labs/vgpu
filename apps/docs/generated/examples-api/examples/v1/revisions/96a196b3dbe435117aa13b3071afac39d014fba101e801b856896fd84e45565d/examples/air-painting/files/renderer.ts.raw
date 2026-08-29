import GUI from "lil-gui";

import { requestCamera, type CameraSource } from "./camera-source";
import { createCameraRenderer, type CameraRenderer } from "./ort-runtime";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let requesting = false;
  let cameraRenderer: CameraRenderer | undefined;
  const cameraRequest = new AbortController();
  const controls = {
    async enableCamera() {
      if (disposed || requesting || cameraRenderer) return;
      requesting = true;
      updateControllers();
      try {
        let camera: CameraSource;
        try {
          camera = await requestCamera(cameraRequest.signal);
        } catch (error) {
          if (disposed && cameraRequest.signal.aborted) return;
          throw error;
        }
        if (disposed) {
          camera.dispose();
          return;
        }
        let renderer: CameraRenderer;
        try {
          renderer = createCameraRenderer({ canvas, camera });
        } catch (error) {
          camera.dispose();
          throw error;
        }
        cameraRenderer = renderer;
        updateControllers();
        try {
          await renderer.ready;
        } catch (error) {
          if (cameraRenderer === renderer) cameraRenderer = undefined;
          throw error;
        }
      } finally {
        requesting = false;
        updateControllers();
      }
    },
    stopCamera() {
      cameraRenderer?.dispose();
      cameraRenderer = undefined;
      updateControllers();
    },
    clear() {
      cameraRenderer?.clear();
    },
  };
  const gui = new GUI({
    title: "Air Painting",
    container: canvas.parentElement ?? undefined,
    width: 180,
  });
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "16px",
    right: "16px",
    zIndex: "10",
  });
  const enable = gui.add(controls, "enableCamera").name("Enable camera");
  const stop = gui.add(controls, "stopCamera").name("Stop camera");
  const clear = gui.add(controls, "clear").name("Clear");

  function updateControllers() {
    if (disposed) return;
    enable.disable(disposed || requesting || Boolean(cameraRenderer));
    stop.disable(disposed || !cameraRenderer);
    clear.disable(disposed || !cameraRenderer);
  }
  updateControllers();

  return {
    ready: Promise.resolve(),
    dispose() {
      if (disposed) return;
      disposed = true;
      let failed = false;
      let failure: unknown;
      for (const cleanup of [
        () => cameraRequest.abort(),
        () => cameraRenderer?.dispose(),
        () => gui.destroy(),
      ]) {
        try {
          cleanup();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
      if (failed) throw failure;
    },
  };
}
