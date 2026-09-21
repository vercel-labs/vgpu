import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canvas: {} as HTMLCanvasElement,
  createRenderer: vi.fn(),
  effect: undefined as (() => void | (() => void)) | undefined,
  isReady: false,
  setIsReady: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect(effect: () => void | (() => void)) {
    mocks.effect = effect;
  },
  useRef() {
    return { current: mocks.canvas };
  },
  useState() {
    return [mocks.isReady, mocks.setIsReady];
  },
}));
vi.mock("./renderer", () => ({ createRenderer: mocks.createRenderer }));

import { Example } from "./index";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function canvasFrom(element: ReturnType<typeof Example>) {
  return element.props.children as {
    props: Record<string, unknown>;
  };
}

beforeEach(() => {
  mocks.effect = undefined;
  mocks.isReady = false;
  mocks.createRenderer.mockReset();
  mocks.setIsReady.mockReset().mockImplementation((ready: boolean) => {
    mocks.isReady = ready;
  });
});

test("keeps the canvas hidden until readiness then applies the shipped fade", async () => {
  const ready = deferred();
  const dispose = vi.fn();
  mocks.createRenderer.mockReturnValue({ ready: ready.promise, dispose });

  const initialCanvas = canvasFrom(Example());
  expect(initialCanvas.props.className).toBe(
    "block h-full w-full touch-none transition-opacity duration-500 opacity-0"
  );
  expect(
    Object.keys(initialCanvas.props).some((name) => name.startsWith("data-"))
  ).toBe(false);

  const cleanup = mocks.effect?.();
  expect(mocks.createRenderer).toHaveBeenCalledWith({ canvas: mocks.canvas });
  ready.resolve();
  await ready.promise;
  await Promise.resolve();

  expect(mocks.setIsReady).toHaveBeenCalledWith(true);
  expect(canvasFrom(Example()).props.className).toBe(
    "block h-full w-full touch-none transition-opacity duration-500 opacity-100"
  );
  cleanup?.();
  expect(dispose).toHaveBeenCalledOnce();
});

test("does not reveal a canvas whose renderer resolves after unmount", async () => {
  const ready = deferred();
  const dispose = vi.fn();
  mocks.createRenderer.mockReturnValue({ ready: ready.promise, dispose });
  Example();

  const cleanup = mocks.effect?.();
  cleanup?.();
  ready.resolve();
  await ready.promise;
  await Promise.resolve();

  expect(mocks.setIsReady).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});
