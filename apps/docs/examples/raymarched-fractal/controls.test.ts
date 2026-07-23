import { expect, test, vi } from 'vitest';
import { createRenderScheduler, installDragOrbit, type Orbit } from './controls';

class CanvasMock {
  style = { touchAction: 'pan-y' };
  listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured = new Set<number>();
  addEventListener(type: string, fn: EventListener) { const set = this.listeners.get(type) ?? new Set(); set.add(fn as never); this.listeners.set(type, set); }
  removeEventListener(type: string, fn: EventListener) { this.listeners.get(type)?.delete(fn as never); }
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
  emit(type: string, event: Partial<PointerEvent>) { for (const fn of this.listeners.get(type) ?? []) fn(event as PointerEvent); }
}

const pointer = (pointerId: number, clientX: number, clientY: number, isPrimary = true) => ({ pointerId, clientX, clientY, isPrimary });

test('vertical drag maps upward motion to lower pitch and downward motion to higher pitch', () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const dispose = installDragOrbit(canvas as unknown as HTMLCanvasElement, orbit, vi.fn());

  canvas.emit('pointerdown', pointer(1, 100, 100));
  canvas.emit('pointermove', pointer(1, 100, 80));
  expect(orbit.pitch).toBeCloseTo(0.12);
  canvas.emit('pointermove', pointer(1, 100, 100));
  expect(orbit.pitch).toBeCloseTo(0.24);

  dispose();
});

test('drag orbit ignores hover/other pointers and stops exactly on up or cancel', () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const requestRender = vi.fn();
  const dispose = installDragOrbit(canvas as unknown as HTMLCanvasElement, orbit, requestRender);
  canvas.emit('pointermove', pointer(1, 50, 50));
  expect(orbit).toEqual({ yaw: 0.58, pitch: 0.24 });
  expect(requestRender).not.toHaveBeenCalled();

  canvas.emit('pointerdown', pointer(1, 10, 10));
  expect(canvas.captured.has(1)).toBe(true);
  canvas.emit('pointermove', pointer(2, 100, 100));
  canvas.emit('pointermove', pointer(1, 30, -300));
  expect(orbit.yaw).toBeCloseTo(0.46);
  expect(orbit.pitch).toBe(-1.15);
  expect(requestRender).toHaveBeenCalledTimes(1);
  canvas.emit('pointerup', pointer(1, 30, -300));
  expect(canvas.captured.has(1)).toBe(false);
  canvas.emit('pointermove', pointer(1, 60, 60));
  expect(requestRender).toHaveBeenCalledTimes(1);

  canvas.emit('pointerdown', pointer(3, 0, 0));
  canvas.emit('pointercancel', pointer(3, 0, 0));
  expect(canvas.captured.has(3)).toBe(false);
  dispose();
  expect(canvas.style.touchAction).toBe('pan-y');
  expect([...canvas.listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test('render scheduler coalesces requests and cancels pending work on dispose', () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  const render = vi.fn();
  const scheduler = createRenderScheduler(render, (cb) => { callbacks.set(++next, cb); return next; }, (id) => callbacks.delete(id));
  scheduler.request(); scheduler.request();
  expect(callbacks.size).toBe(1);
  const first = callbacks.get(1); callbacks.delete(1); first?.(0);
  expect(render).toHaveBeenCalledTimes(1);
  scheduler.request();
  scheduler.dispose();
  expect(callbacks.size).toBe(0);
});
