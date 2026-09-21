import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canvas: {} as HTMLCanvasElement,
  createRenderer: vi.fn(),
  effect: undefined as (() => void | (() => void)) | undefined,
  hintVisible: true,
  setHintVisible: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect(effect: () => void | (() => void)) {
    mocks.effect = effect;
  },
  useRef() {
    return { current: mocks.canvas };
  },
  useState() {
    return [mocks.hintVisible, mocks.setHintVisible];
  },
}));
vi.mock("./renderer", () => ({ createRenderer: mocks.createRenderer }));

import { Example } from "./index";

function children() {
  return Example().props.children as Array<{
    props: Record<string, unknown>;
  }>;
}

beforeEach(() => {
  mocks.effect = undefined;
  mocks.hintVisible = true;
  mocks.createRenderer.mockReset().mockReturnValue({
    ready: Promise.resolve(),
    dispose: vi.fn(),
  });
  mocks.setHintVisible.mockReset().mockImplementation((visible: boolean) => {
    mocks.hintVisible = visible;
  });
});

test("preserves the instructional hint and its 400ms pointerdown fade", () => {
  const [canvas, hint] = children();
  expect(canvas.props.className).toBe("block h-full w-full touch-none");
  expect(hint.props.children).toBe("drag to look around");
  expect(hint.props.className).toBe(
    "pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-xs font-medium uppercase tracking-[0.08em] text-white/80 transition-opacity duration-[400ms] opacity-100"
  );

  (canvas.props.onPointerDown as () => void)();
  expect(mocks.setHintVisible).toHaveBeenCalledWith(false);
  expect(children()[1]!.props.className).toBe(
    "pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-xs font-medium uppercase tracking-[0.08em] text-white/80 transition-opacity duration-[400ms] opacity-0"
  );
});

test("mounts the local renderer and disposes it on unmount", () => {
  const dispose = vi.fn();
  mocks.createRenderer.mockReturnValue({ ready: Promise.resolve(), dispose });
  Example();

  const cleanup = mocks.effect?.();
  expect(mocks.createRenderer).toHaveBeenCalledWith({ canvas: mocks.canvas });
  cleanup?.();
  expect(dispose).toHaveBeenCalledOnce();
});
