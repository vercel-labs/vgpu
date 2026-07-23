import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('vgpu', async () => import('vgpu/mock'));

import { exampleRunners } from './example-runners';
import { examples } from './examples-registry';

class StubElement {
  style: Record<string, string> = {};
  parentElement: StubElement | null = null;
  value = '';
  title = '';
  innerHTML = '';
  textContent = '';
  checked = false;
  dataset: Record<string, string> = {};
  setAttribute() {}
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
  addEventListener() {}
  removeEventListener() {}
  append(child: StubElement) { child.parentElement = this; }
  remove() { this.parentElement = null; }
  closest() { return null; }
}

function stubCanvas(): HTMLCanvasElement {
  const parent = new StubElement();
  const canvas = new StubElement() as StubElement & Record<string, unknown>;
  canvas.parentElement = parent;
  canvas.width = 160;
  canvas.height = 90;
  canvas.clientWidth = 160;
  canvas.clientHeight = 90;
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 160, bottom: 90, width: 160, height: 90, toJSON() {} });
  canvas.getContext = (kind: string) => kind === 'webgpu' ? {
    canvas,
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => ({ createView: () => ({}) }),
  } : null;
  return canvas as unknown as HTMLCanvasElement;
}

let frames: Map<number, FrameRequestCallback>;
let frameId: number;

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal('Element', StubElement);
  vi.stubGlobal('document', {
    hidden: false,
    body: new StubElement(),
    createElement: () => new StubElement(),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('getComputedStyle', () => ({ position: 'static' }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++frameId; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});

afterEach(() => vi.unstubAllGlobals());

test('runner map exactly covers the examples registry', () => {
  expect(Object.keys(exampleRunners).sort()).toEqual(examples.map(({ meta }) => meta.slug).sort());
});

test.each(examples)('boots setup, first frame, and cleanup for $meta.slug', async ({ meta }) => {
  const cleanup = await exampleRunners[meta.slug as keyof typeof exampleRunners](stubCanvas());
  const firstFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
  expect(firstFrame, `${meta.slug} did not schedule its first frame`).toBeDefined();
  if (firstFrame) {
    frames.delete(firstFrame[0]);
    firstFrame[1](performance.now() + 16);
  }
  expect(() => cleanup(), `${meta.slug} cleanup failed`).not.toThrow();
});
