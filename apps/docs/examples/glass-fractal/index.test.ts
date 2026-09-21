import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canvas: {} as HTMLCanvasElement,
  canvasRef: { current: null as HTMLCanvasElement | null },
  effect: undefined as (() => void | (() => void)) | undefined,
  isReady: false,
  refCalls: 0,
  rendererRef: { current: null as ReturnType<typeof createRenderer> | null },
  setIsReady: vi.fn(),
  setShape: vi.fn(),
  shape: "fractal",
}));

const createRenderer = vi.hoisted(() => vi.fn());

vi.mock("react", () => ({
  useEffect(effect: () => void | (() => void)) {
    mocks.effect = effect;
  },
  useRef() {
    return mocks.refCalls++ === 0 ? mocks.canvasRef : mocks.rendererRef;
  },
  useState(initial: unknown) {
    return initial === "fractal"
      ? [mocks.shape, mocks.setShape]
      : [mocks.isReady, mocks.setIsReady];
  },
}));

vi.mock("./renderer", () => ({ createRenderer }));

import { Example } from "./index";

interface Element {
  props: Record<string, unknown>;
}

beforeEach(() => {
  mocks.canvasRef.current = mocks.canvas;
  mocks.effect = undefined;
  mocks.isReady = false;
  mocks.refCalls = 0;
  mocks.rendererRef.current = null;
  mocks.setIsReady.mockReset();
  mocks.setShape.mockReset();
  mocks.shape = "fractal";
  createRenderer.mockReset();
});

test("keeps the original HTML shape switch outside lil-gui", () => {
  const renderer = {
    dispose: vi.fn(),
    ready: Promise.resolve(),
    setSphereMix: vi.fn(),
  };
  createRenderer.mockReturnValue(renderer);

  const example = Example();
  const [, selector] = example.props.children as [unknown, Element];
  const buttons = selector.props.children as Element[];

  expect(selector.props).toMatchObject({
    "aria-label": "Fractal shape",
    role: "group",
  });
  expect(buttons.map((button) => button.props.children)).toEqual([
    "Fractal",
    "Orb",
  ]);
  expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([
    true,
    false,
  ]);

  const cleanup = mocks.effect?.();
  (buttons[1]?.props.onClick as () => void)();
  expect(mocks.setShape).toHaveBeenCalledWith("orb");
  expect(renderer.setSphereMix).toHaveBeenCalledWith(1);

  cleanup?.();
  (buttons[0]?.props.onClick as () => void)();
  expect(renderer.setSphereMix).toHaveBeenCalledTimes(1);
  expect(renderer.dispose).toHaveBeenCalledOnce();
});
