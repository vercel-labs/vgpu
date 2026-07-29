import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init as initBrowser, bundle, draw, effect, frame, pingPong, surface, target } from "../src/index.ts";
import { createMockAdapter, init } from "../src/mock.ts";

const SOLID = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0, 1); }
`;

function canvasLike(width = 10, height = 5, layout = true): HTMLCanvasElement {
  const context = {
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: () => ({ createView: () => ({}) }),
  };
  const canvas: Record<string, unknown> = {
    width: 0,
    height: 0,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return { ...context, canvas };
    },
    __context: context,
  };
  if (layout) {
    canvas.clientWidth = width;
    canvas.clientHeight = height;
  } else {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas as unknown as HTMLCanvasElement;
}

function contextOf(canvas: HTMLCanvasElement) {
  return (canvas as unknown as { __context: { configure: ReturnType<typeof vi.fn>; unconfigure: ReturnType<typeof vi.fn> } }).__context;
}

test("surface configures layout-backed canvas, syncs initial physical size, and respects fixed size defaulting autoResize false", async () => {
  const canvas = canvasLike(20, 10);
  const gpu = await initBrowser({ adapter: createMockAdapter() });

  const canvasSurface = surface(gpu, canvas, { dpr: 2, label: "main" });
  expect(canvasSurface.size).toEqual([40, 20]);
  expect(canvasSurface.dpr).toBe(2);
  expect(canvasSurface.autoResize).toBe(true);
  expect(canvasSurface.layoutBacked).toBe(true);
  expect(canvas.width).toBe(40);
  expect(canvas.height).toBe(20);
  expect(contextOf(canvas).configure).toHaveBeenCalledTimes(1);

  canvasSurface.dispose();
  const fixed = surface(gpu, canvas, { size: [7.9, 3.1] });
  expect(fixed.size).toEqual([7, 3]);
  expect(fixed.autoResize).toBe(false);
  gpu.dispose();
});

test("autoResize fires at frame boundary once with physical payload and immediate subscription event", async () => {
  const canvas = canvasLike(10, 5);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvas, { dpr: 2 });
  const seen: unknown[] = [];
  const unsubscribe = canvasSurface.onResize((event) => seen.push({ width: event.width, height: event.height, dpr: event.dpr, same: event.surface === canvasSurface }));

  expect(seen).toEqual([{ width: 20, height: 10, dpr: 2, same: true }]);
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientWidth = 11;
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientHeight = 6;
  frame(gpu);
  frame(gpu);
  expect(seen).toEqual([
    { width: 20, height: 10, dpr: 2, same: true },
    { width: 22, height: 12, dpr: 2, same: true },
  ]);
  unsubscribe();
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientWidth = 12;
  frame(gpu);
  expect(seen).toHaveLength(2);
  gpu.dispose();
});

test("immediate onResize callback also guards frame reentrancy", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvasLike(10, 10));
  let checked = false;

  canvasSurface.onResize(() => {
    checked = true;
    expect(() => frame(gpu)).toThrowError(/VGPU-FRAME-REENTRANT|Nested frame/);
  });

  expect(checked).toBe(true);
  gpu.dispose();
});

test("multi-surface autoResize callbacks run in creation order and shared handler can inspect event.surface", async () => {
  const a = canvasLike(10, 5);
  const b = canvasLike(20, 10);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const sa = surface(gpu, a);
  const sb = surface(gpu, b);
  const order: string[] = [];
  sa.onResize((event) => { if (event.width !== 10) order.push(event.surface === sa ? "a" : "?"); });
  sb.onResize((event) => { if (event.width !== 20) order.push(event.surface === sb ? "b" : "?"); });

  (a as unknown as { clientWidth: number }).clientWidth = 11;
  (b as unknown as { clientWidth: number }).clientWidth = 21;
  frame(gpu);
  expect(order).toEqual(["a", "b"]);
  gpu.dispose();
});

test("manual resize fires synchronously, same-size is no-op, and unsubscribe during dispatch affects the next dispatch", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvasLike(8, 8), { autoResize: false });
  const seen: string[] = [];
  let offA = () => undefined;
  offA = canvasSurface.onResize(() => { seen.push("a"); offA(); });
  canvasSurface.onResize(() => { seen.push("b"); });
  seen.length = 0;

  canvasSurface.resize([16, 8]);
  expect(seen).toEqual(["a", "b"]);
  canvasSurface.resize([16, 8]);
  expect(seen).toEqual(["a", "b"]);
  canvasSurface.resize([17, 8]);
  expect(seen).toEqual(["a", "b", "b"]);
  gpu.dispose();
});

test("buffer-only surfaces default autoResize false, reject explicit autoResize true, and do not grow with dpr", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvas = canvasLike(16, 8, false);
  const canvasSurface = surface(gpu, canvas, { dpr: 2 });
  expect(canvasSurface.autoResize).toBe(false);
  expect(canvasSurface.layoutBacked).toBe(false);
  expect(canvasSurface.size).toEqual([16, 8]);
  for (let i = 0; i < 10; i += 1) frame(gpu);
  expect(canvasSurface.size).toEqual([16, 8]);

  expect(() => surface(gpu, canvasLike(1, 1, false), { autoResize: true })).toThrowError(/VGPU-SURFACE-AUTORESIZE-UNSUPPORTED|autoResize needs/);
  gpu.dispose();
});

test("dpr override, tuple clamp, and runtime devicePixelRatio changes are applied per surface", async () => {
  const original = globalThis.devicePixelRatio;
  vi.stubGlobal("devicePixelRatio", 3);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const fixedCanvas = canvasLike(10, 10);
  const clampedCanvas = canvasLike(10, 10);
  const fixed = surface(gpu, fixedCanvas, { dpr: 1 });
  const clamped = surface(gpu, clampedCanvas, { dpr: [1, 2] });
  expect(fixed.size).toEqual([10, 10]);
  expect(clamped.size).toEqual([20, 20]);

  vi.stubGlobal("devicePixelRatio", 1.5);
  (clampedCanvas as unknown as { clientWidth: number }).clientWidth = 12;
  frame(gpu);
  expect(clamped.dpr).toBe(1.5);
  expect(clamped.size).toEqual([18, 15]);
  vi.stubGlobal("devicePixelRatio", original);
  gpu.dispose();
});

test("surface lifecycle rejects duplicates, disposes, unregisters, and allows re-creation", async () => {
  const canvas = canvasLike(10, 10);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvas, { label: "main" });
  expect(() => surface(gpu, canvas)).toThrowError(/VGPU-SURFACE-DUPLICATE|already has surface/);
  canvasSurface.dispose();
  expect(contextOf(canvas).unconfigure).toHaveBeenCalledTimes(1);
  expect(() => canvasSurface.resize([1, 1])).toThrowError(/VGPU-SURFACE-DISPOSED|disposed/);
  expect(() => canvasSurface.onResize(() => undefined)).toThrowError(/VGPU-SURFACE-DISPOSED|disposed/);
  const recreated = surface(gpu, canvas);
  expect(recreated.disposed).toBe(false);
  gpu.dispose();
  expect(recreated.disposed).toBe(true);
});

test("resize and frame reentrancy are guarded, but resizing another surface and creating resources is allowed", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const a = surface(gpu, canvasLike(10, 10), { autoResize: false });
  const b = surface(gpu, canvasLike(10, 10), { autoResize: false });
  a.onResize(() => undefined);
  a.onResize(() => { expect(() => target(gpu, { size: [2, 2] })).not.toThrow(); });
  a.onResize(() => { b.resize([12, 12]); });
  a.onResize(() => { expect(() => a.resize([20, 20])).toThrowError(/VGPU-SURFACE-RESIZE-REENTRANT|Cannot resize/); });
  a.onResize(() => { expect(() => frame(gpu)).toThrowError(/VGPU-FRAME-REENTRANT|Nested frame/); });
  expect(() => a.resize([11, 11])).not.toThrow();
  expect(b.size).toEqual([12, 12]);
  gpu.dispose();
});

test("target is required for frame and one-shot draws, and target size is required at runtime", async () => {
  const gpu = await init();
  const shader1 = effect(gpu, SOLID);
  const drawable = draw(gpu, { shader: SOLID });
  expect(() => {
    // @ts-expect-error Frame.pass requires an explicit target; this asserts the runtime JS error.
    frame(gpu, (currentFrame) => currentFrame.pass({}, (p) => p.draw(shader1)));
  }).toThrowError(/VGPU-TARGET-REQUIRED|Target required/);
  expect(() => shader1.draw()).toThrowError(/VGPU-TARGET-REQUIRED|Target required/);
  expect(() => drawable.draw()).toThrowError(/VGPU-TARGET-REQUIRED|Target required/);
  expect(() => {
    // @ts-expect-error target(gpu, opts) requires size; this asserts the runtime JS error.
    target(gpu, {});
  }).toThrowError(/VGPU-TARGET-SIZE-REQUIRED|Target size required/);
  const pp = pingPong(gpu, 8,
    8,
    // @ts-expect-error pingPong options intentionally do not accept size; positional dimensions win.
    { size: [4, 4] },
  );
  expect(pp.read.size).toEqual([8, 8]);
  gpu.dispose();
});

test("bloom pattern immediate same-size resize does not recreate derived target texture", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvasLike(20, 10));
  const bloom = target(gpu, { size: [canvasSurface.size[0] / 2, canvasSurface.size[1] / 2] });
  const color = bloom.color;
  canvasSurface.onResize(({ width, height }) => bloom.resize([width / 2, height / 2]));
  expect(bloom.color).toBe(color);
  gpu.dispose();
});

test("surface bundle survives resize, and re-recording from onResize is usable in the same frame", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const manual = surface(gpu, canvasLike(10, 10), { autoResize: false });
  const shader1 = effect(gpu, SOLID);
  const resizeBundle = bundle(gpu, { target: { colors: [manual.format] }, label: "surfaceBundle" }, (b) => b.draw(shader1));

  manual.resize([12, 12]);
  expect(() => frame(gpu, (f) => f.pass({ target: manual }, (p) => p.bundles(resizeBundle)))).not.toThrow();

  const canvas = canvasLike(10, 10);
  const canvasSurface = surface(gpu, canvas);
  let recorded = bundle(gpu, { target: { colors: [canvasSurface.format] }, label: "surfaceBundleFresh" }, (b) => b.draw(shader1));
  canvasSurface.onResize(() => { recorded = bundle(gpu, { target: { colors: [canvasSurface.format] }, label: "surfaceBundleFresh" }, (b) => b.draw(shader1)); });
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientWidth = 13;
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientHeight = 13;
  expect(() => frame(gpu, (f) => f.pass({ target: canvasSurface }, (p) => p.bundles(recorded)))).not.toThrow();
  canvasSurface.dispose();
  expect(() => frame(gpu, (f) => f.pass({ target: canvasSurface }, (p) => p.bundles(recorded)))).toThrowError(/VGPU-SURFACE-DISPOSED|disposed/);
  gpu.dispose();
});

test("a deferred frame can pass a surface before manual submit", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvasSurface = surface(gpu, canvasLike(4, 4), { autoResize: false });
  const shader1 = effect(gpu, SOLID);
  const currentFrame = frame(gpu);

  expect(() => currentFrame.pass(canvasSurface, shader1)).not.toThrow();
  currentFrame.submit();
  gpu.dispose();
});
