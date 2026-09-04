import { expect, test, vi } from 'vitest';

import type { Animation } from './animation';
import { installFieldInput } from './input';

class CanvasMock {
  style = { touchAction: 'pan-y' };
  listeners = new Map<string, Set<EventListener>>();
  captured = new Set<number>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(id: number) {
    this.captured.add(id);
  }

  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }

  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 200, height: 100 };
  }

  emit(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as unknown as Event);
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function animationMock(): Animation {
  return {
    rotate: vi.fn(),
    release: vi.fn(),
    setPointer: vi.fn(),
    clearPointer: vi.fn(),
  } as unknown as Animation;
}

const mouse = (extra: Record<string, unknown>) => ({ isPrimary: true, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0, ...extra });

test('dragging rotates by pixel delta and springs back on release', () => {
  const canvas = new CanvasMock();
  const animation = animationMock();
  const input = installFieldInput(canvas as unknown as HTMLCanvasElement, animation);
  expect(canvas.style.touchAction).toBe('none');

  canvas.emit('pointerdown', mouse({ clientX: 100, clientY: 50 }));
  expect(canvas.captured.has(1)).toBe(true);
  expect(animation.setPointer).toHaveBeenLastCalledWith(0, 0, true);

  canvas.emit('pointermove', mouse({ clientX: 140, clientY: 30, buttons: 1 }));
  expect(animation.rotate).toHaveBeenCalledWith(-20 * 0.005, 40 * 0.005);
  expect(animation.setPointer).toHaveBeenLastCalledWith(expect.closeTo(0.4, 6), expect.closeTo(0.4, 6), true);

  // A second pointer during the drag is ignored.
  canvas.emit('pointermove', mouse({ pointerId: 2, clientX: 0, clientY: 0, buttons: 1 }));
  expect(animation.rotate).toHaveBeenCalledTimes(1);

  canvas.emit('pointerup', mouse({ clientX: 140, clientY: 30 }));
  expect(canvas.captured.size).toBe(0);
  expect(animation.release).toHaveBeenCalledOnce();
  // Releasing inside the canvas hands over to hover repel.
  expect(animation.setPointer).toHaveBeenLastCalledWith(expect.closeTo(0.4, 6), expect.closeTo(0.4, 6), false);
  input.dispose();
});

test('hovering feeds the repel pointer for mouse only, and leaving clears it', () => {
  const canvas = new CanvasMock();
  const animation = animationMock();
  const input = installFieldInput(canvas as unknown as HTMLCanvasElement, animation);

  canvas.emit('pointermove', mouse({ clientX: 50, clientY: 75 }));
  expect(animation.setPointer).toHaveBeenLastCalledWith(-0.5, -0.5, false);
  canvas.emit('pointermove', { isPrimary: true, pointerType: 'touch', pointerId: 3, clientX: 10, clientY: 10, buttons: 0 });
  expect(animation.setPointer).toHaveBeenCalledTimes(1);
  expect(animation.rotate).not.toHaveBeenCalled();

  canvas.emit('pointerleave', mouse({}));
  expect(animation.clearPointer).toHaveBeenCalledOnce();
  input.dispose();
});

test('arrow keys nudge the rotation and dispose restores the canvas', () => {
  const canvas = new CanvasMock();
  const animation = animationMock();
  const input = installFieldInput(canvas as unknown as HTMLCanvasElement, animation);
  const preventDefault = vi.fn();

  canvas.emit('keydown', { key: 'ArrowLeft', preventDefault });
  canvas.emit('keydown', { key: 'ArrowDown', preventDefault });
  canvas.emit('keydown', { key: 'Enter', preventDefault });
  expect(animation.rotate).toHaveBeenNthCalledWith(1, 0, -0.08);
  expect(animation.rotate).toHaveBeenNthCalledWith(2, 0.08, 0);
  expect(preventDefault).toHaveBeenCalledTimes(2);
  canvas.emit('keyup', { key: 'ArrowLeft' });
  expect(animation.release).toHaveBeenCalledOnce();

  canvas.emit('pointerdown', mouse({ clientX: 10, clientY: 10 }));
  input.dispose();
  expect(canvas.captured.size).toBe(0);
  expect(canvas.style.touchAction).toBe('pan-y');
  expect(canvas.listenerCount).toBe(0);
});
