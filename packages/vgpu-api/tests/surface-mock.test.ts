import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init as initBrowser } from "../src/index.ts";
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

  const surface = gpu.surface(canvas, { dpr: 2, label: "main" });
  expect(surface.size).toEqual([40, 20]);
  expect(surface.dpr).toBe(2);
  expect(surface.autoResize).toBe(true);
  expect(surface.layoutBacked).toBe(true);
  expect(canvas.width).toBe(40);
  expect(canvas.height).toBe(20);
  expect(contextOf(canvas).configure).toHaveBeenCalledTimes(1);

  surface.dispose();
  const fixed = gpu.surface(canvas, { size: [7.9, 3.1] });
  expect(fixed.size).toEqual([7, 3]);
  expect(fixed.autoResize).toBe(false);
  gpu.dispose();
});

test("autoResize fires at frame boundary once with physical payload and immediate subscription event", async () => {
  const canvas = canvasLike(10, 5);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const surface = gpu.surface(canvas, { dpr: 2 });
  const seen: unknown[] = [];
  const unsubscribe = surface.onResize((event) => seen.push({ width: event.width, height: event.height, dpr: event.dpr, same: event.surface === surface }));

  expect(seen).toEqual([{ width: 20, height: 10, dpr: 2, same: true }]);
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientWidth = 11;
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientHeight = 6;
  gpu.frame();
  gpu.frame();
  expect(seen).toEqual([
    { width: 20, height: 10, dpr: 2, same: true },
    { width: 22, height: 12, dpr: 2, same: true },
  ]);
  unsubscribe();
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientWidth = 12;
  gpu.frame();
  expect(seen).toHaveLength(2);
  gpu.dispose();
});

test("multi-surface autoResize callbacks run in creation order and shared handler can inspect event.surface", async () => {
  const a = canvasLike(10, 5);
  const b = canvasLike(20, 10);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const sa = gpu.surface(a);
  const sb = gpu.surface(b);
  const order: string[] = [];
  sa.onResize((event) => { if (event.width !== 10) order.push(event.surface === sa ? "a" : "?"); });
  sb.onResize((event) => { if (event.width !== 20) order.push(event.surface === sb ? "b" : "?"); });

  (a as unknown as { clientWidth: number }).clientWidth = 11;
  (b as unknown as { clientWidth: number }).clientWidth = 21;
  gpu.frame();
  expect(order).toEqual(["a", "b"]);
  gpu.dispose();
});

test("manual resize fires synchronously, same-size is no-op, and unsubscribe during dispatch affects the next dispatch", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const surface = gpu.surface(canvasLike(8, 8), { autoResize: false });
  const seen: string[] = [];
  let offA = () => undefined;
  offA = surface.onResize(() => { seen.push("a"); offA(); });
  surface.onResize(() => { seen.push("b"); });
  seen.length = 0;

  surface.resize([16, 8]);
  expect(seen).toEqual(["a", "b"]);
  surface.resize([16, 8]);
  expect(seen).toEqual(["a", "b"]);
  surface.resize([17, 8]);
  expect(seen).toEqual(["a", "b", "b"]);
  gpu.dispose();
});

test("buffer-only surfaces default autoResize false, reject explicit autoResize true, and do not grow with dpr", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const canvas = canvasLike(16, 8, false);
  const surface = gpu.surface(canvas, { dpr: 2 });
  expect(surface.autoResize).toBe(false);
  expect(surface.layoutBacked).toBe(false);
  expect(surface.size).toEqual([16, 8]);
  for (let i = 0; i < 10; i += 1) gpu.frame();
  expect(surface.size).toEqual([16, 8]);

  expect(() => gpu.surface(canvasLike(1, 1, false), { autoResize: true })).toThrowError(/VGPU-SURFACE-AUTORESIZE-UNSUPPORTED|autoResize requiere/);
  gpu.dispose();
});

test("dpr override, tuple clamp, and runtime devicePixelRatio changes are applied per surface", async () => {
  const original = globalThis.devicePixelRatio;
  vi.stubGlobal("devicePixelRatio", 3);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const fixedCanvas = canvasLike(10, 10);
  const clampedCanvas = canvasLike(10, 10);
  const fixed = gpu.surface(fixedCanvas, { dpr: 1 });
  const clamped = gpu.surface(clampedCanvas, { dpr: [1, 2] });
  expect(fixed.size).toEqual([10, 10]);
  expect(clamped.size).toEqual([20, 20]);

  vi.stubGlobal("devicePixelRatio", 1.5);
  (clampedCanvas as unknown as { clientWidth: number }).clientWidth = 12;
  gpu.frame();
  expect(clamped.dpr).toBe(1.5);
  expect(clamped.size).toEqual([18, 15]);
  vi.stubGlobal("devicePixelRatio", original);
  gpu.dispose();
});

test("surface lifecycle rejects duplicates, disposes, unregisters, and allows re-creation", async () => {
  const canvas = canvasLike(10, 10);
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const surface = gpu.surface(canvas, { label: "main" });
  expect(() => gpu.surface(canvas)).toThrowError(/VGPU-SURFACE-DUPLICATE|ya existe una surface/);
  surface.dispose();
  expect(contextOf(canvas).unconfigure).toHaveBeenCalledTimes(1);
  expect(() => surface.resize([1, 1])).toThrowError(/VGPU-SURFACE-DISPOSED|disposed/);
  expect(() => surface.onResize(() => undefined)).toThrowError(/VGPU-SURFACE-DISPOSED|disposed/);
  const recreated = gpu.surface(canvas);
  expect(recreated.disposed).toBe(false);
  gpu.dispose();
  expect(recreated.disposed).toBe(true);
});

test("resize and frame reentrancy are guarded, but resizing another surface and creating resources is allowed", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const a = gpu.surface(canvasLike(10, 10), { autoResize: false });
  const b = gpu.surface(canvasLike(10, 10), { autoResize: false });
  a.onResize(() => undefined);
  a.onResize(() => { expect(() => gpu.target({ size: [2, 2] })).not.toThrow(); });
  a.onResize(() => { b.resize([12, 12]); });
  a.onResize(() => { expect(() => a.resize([20, 20])).toThrowError(/VGPU-SURFACE-RESIZE-REENTRANT|no puede llamarse/); });
  a.onResize(() => { expect(() => gpu.frame()).toThrowError(/VGPU-FRAME-REENTRANT|no puede llamarse/); });
  expect(() => a.resize([11, 11])).not.toThrow();
  expect(b.size).toEqual([12, 12]);
  gpu.dispose();
});

test("target is required for frame and one-shot draws, and target size is required at runtime", async () => {
  const gpu = await init();
  const pass = gpu.pass(SOLID);
  const draw = gpu.draw({ shader: SOLID });
  expect(() => gpu.frame((frame) => frame.pass({} as never, (p) => p.draw(pass)))).toThrowError(/VGPU-TARGET-REQUIRED|target explícito/);
  expect(() => pass.draw()).toThrowError(/VGPU-TARGET-REQUIRED|target explícito/);
  expect(() => draw.draw()).toThrowError(/VGPU-TARGET-REQUIRED|target explícito/);
  expect(() => gpu.target({} as never)).toThrowError(/VGPU-TARGET-SIZE-REQUIRED|requiere size/);
  const pp = gpu.pingPong(8, 8, { size: [4, 4] } as never);
  expect(pp.read.size).toEqual([8, 8]);
  gpu.dispose();
});

test("bloom pattern immediate same-size resize does not recreate derived target texture", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const surface = gpu.surface(canvasLike(20, 10));
  const bloom = gpu.target({ size: [surface.size[0] / 2, surface.size[1] / 2] });
  const color = bloom.color;
  surface.onResize(({ width, height }) => bloom.resize([width / 2, height / 2]));
  expect(bloom.color).toBe(color);
  gpu.dispose();
});

test("surface bundle stale on resize, and re-recording from onResize is usable in the same frame", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const manual = gpu.surface(canvasLike(10, 10), { autoResize: false });
  const pass = gpu.pass(SOLID);
  const staleBundle = gpu.bundle({ target: manual, label: "surfaceBundle" }, (b) => b.draw(pass));

  manual.resize([12, 12]);
  expect(() => gpu.frame((f) => f.pass({ target: manual }, (p) => p.bundles(staleBundle)))).toThrowError(/VGPU-R3-BUNDLE-STALE|stale/);

  const canvas = canvasLike(10, 10);
  const surface = gpu.surface(canvas);
  let bundle = gpu.bundle({ target: surface, label: "surfaceBundleFresh" }, (b) => b.draw(pass));
  surface.onResize(() => { bundle = gpu.bundle({ target: surface, label: "surfaceBundleFresh" }, (b) => b.draw(pass)); });
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientWidth = 13;
  (canvas as unknown as { clientWidth: number; clientHeight: number }).clientHeight = 13;
  expect(() => gpu.frame((f) => f.pass({ target: surface }, (p) => p.bundles(bundle)))).not.toThrow();
  surface.dispose();
  expect(() => gpu.frame((f) => f.pass({ target: surface }, (p) => p.bundles(bundle)))).toThrowError(/VGPU-SURFACE-DISPOSED|disposed/);
  gpu.dispose();
});
