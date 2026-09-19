import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  gpuDispose: vi.fn(),
  loopStop: vi.fn(),
  inputDispose: vi.fn(),
  sceneDispose: vi.fn(),
  sceneResize: vi.fn(),
  render: vi.fn(),
  resizeCallback: undefined as (() => void) | undefined,
  frameCallback: undefined as (() => void) | undefined,
}));

vi.mock("vgpu", () => ({
  init: vi.fn(async () => ({ dispose: state.gpuDispose })),
  surface: vi.fn(() => ({
    size: [640, 360],
    onResize(callback: () => void) {
      state.resizeCallback = callback;
      return vi.fn();
    },
  })),
  clock: vi.fn(() => ({ time: 1, deltaTime: 1 / 60 })),
  frameLoop: vi.fn((_gpu, callback: () => void) => {
    state.frameCallback = callback;
    return { stop: state.loopStop };
  }),
}));

vi.mock("./pointer-input", () => ({
  installShapeInput: vi.fn(() => ({
    position: [0, 0],
    strength: 0,
    update: vi.fn(),
    dispose: state.inputDispose,
  })),
}));

vi.mock("./simulation", () => ({
  createLiquidGeoScene: vi.fn(async () => ({ id: "scene" })),
  destroyLiquidGeoScene: state.sceneDispose,
  renderLiquidGeo: state.render,
  resizeLiquidGeoScene: state.sceneResize,
}));

import { createRenderer } from "./renderer";

class CanvasMock {
  style = { touchAction: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.resizeCallback = undefined;
  state.frameCallback = undefined;
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({ matches: false })),
  });
  vi.stubGlobal("IntersectionObserver", undefined);
});

test("resize is forwarded and disposal is safe when repeated", async () => {
  const renderer = createRenderer({
    canvas: new CanvasMock() as unknown as HTMLCanvasElement,
  });
  await renderer.ready;
  state.resizeCallback?.();
  expect(state.sceneResize).toHaveBeenCalledTimes(1);

  renderer.dispose();
  renderer.dispose();
  expect(state.loopStop).toHaveBeenCalledTimes(1);
  expect(state.inputDispose).toHaveBeenCalledTimes(1);
  expect(state.sceneDispose).toHaveBeenCalledTimes(1);
  expect(state.gpuDispose).toHaveBeenCalledTimes(1);
});

test("disposal during initialization releases the late GPU exactly once", async () => {
  const renderer = createRenderer({
    canvas: new CanvasMock() as unknown as HTMLCanvasElement,
  });
  renderer.dispose();
  await renderer.ready;
  expect(state.gpuDispose).toHaveBeenCalledTimes(0);
  expect(state.frameCallback).toBeUndefined();
});

test("shape control eases toward Earth without swapping the scene", async () => {
  const renderer = createRenderer({
    canvas: new CanvasMock() as unknown as HTMLCanvasElement,
  });
  await renderer.ready;
  renderer.setEarthMix(1);
  state.frameCallback?.();

  const frameState = state.render.mock.calls.at(-1)?.[3];
  expect(frameState.earthMix).toBeGreaterThan(0);
  expect(frameState.earthMix).toBeLessThan(1);
  expect(state.sceneDispose).not.toHaveBeenCalled();
  renderer.dispose();
});
