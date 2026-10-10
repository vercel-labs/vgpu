import { expect, test, vi } from 'vitest';

import { attachInput, type InputActions } from './input';

/** Records listeners and honours the AbortSignal attachInput registers them with. */
class CanvasMock {
  listeners = new Map<string, Set<EventListener>>();
  captured = new Set<number>();

  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    options?.signal?.addEventListener('abort', () => this.removeEventListener(type, listener));
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

  emit(type: string, event: Record<string, unknown>) {
    const full = { type, preventDefault: vi.fn(), ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(full as unknown as Event);
    return full;
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function setup() {
  const canvas = new CanvasMock();
  const actions: InputActions = {
    orbit: vi.fn(),
    zoom: vi.fn(),
    release: vi.fn(),
    releaseBatch: vi.fn(),
    togglePause: vi.fn(),
    step: vi.fn(),
    reset: vi.fn(),
    resetView: vi.fn(),
  };
  const guard = vi.fn((action: () => void) => action());
  const input = attachInput(canvas as unknown as HTMLCanvasElement, actions, guard);
  return { canvas, actions, guard, input };
}

const pointer = (extra: Record<string, unknown>) => ({ pointerId: 1, button: 0, clientX: 0, clientY: 0, timeStamp: 0, ...extra });

test('a quick tap releases a marble; a drag orbits instead', () => {
  const { canvas, actions } = setup();
  canvas.emit('pointerdown', pointer({ clientX: 100, clientY: 50, timeStamp: 1000 }));
  expect(canvas.captured.has(1)).toBe(true);
  canvas.emit('pointerup', pointer({ clientX: 102, clientY: 52, timeStamp: 1120 }));
  expect(actions.release).toHaveBeenCalledOnce();
  expect(canvas.captured.size).toBe(0);

  canvas.emit('pointerdown', pointer({ clientX: 100, clientY: 50, timeStamp: 2000 }));
  canvas.emit('pointermove', pointer({ clientX: 140, clientY: 30, timeStamp: 2050 }));
  expect(actions.orbit).toHaveBeenLastCalledWith(-40 * 0.006, -20 * 0.005);
  canvas.emit('pointerup', pointer({ clientX: 140, clientY: 30, timeStamp: 2100 }));
  expect(actions.release).toHaveBeenCalledOnce();
});

test('a long press, a cancelled press and other buttons do not release', () => {
  const { canvas, actions } = setup();
  canvas.emit('pointerdown', pointer({ timeStamp: 0 }));
  canvas.emit('pointerup', pointer({ timeStamp: 600 }));
  canvas.emit('pointerdown', pointer({ timeStamp: 1000 }));
  canvas.emit('pointercancel', pointer({ timeStamp: 1050 }));
  canvas.emit('pointerdown', pointer({ button: 2, timeStamp: 2000 }));
  canvas.emit('pointerup', pointer({ button: 2, timeStamp: 2050 }));
  expect(actions.release).not.toHaveBeenCalled();
  expect(canvas.captured.size).toBe(0);
});

test('two touches pinch to zoom and never end as a tap', () => {
  const { canvas, actions } = setup();
  canvas.emit('pointerdown', pointer({ pointerId: 1, clientX: 100, clientY: 100, timeStamp: 0 }));
  canvas.emit('pointerdown', pointer({ pointerId: 2, clientX: 200, clientY: 100, timeStamp: 10 }));
  // A third finger is ignored.
  canvas.emit('pointerdown', pointer({ pointerId: 3, clientX: 300, clientY: 300, timeStamp: 20 }));
  expect(canvas.captured.has(3)).toBe(false);
  canvas.emit('pointermove', pointer({ pointerId: 2, clientX: 300, clientY: 100, timeStamp: 30 }));
  // Spreading from 100 to 200 px halves the camera distance.
  expect(actions.zoom).toHaveBeenLastCalledWith(0.5);
  expect(actions.orbit).not.toHaveBeenCalled();
  canvas.emit('pointerup', pointer({ pointerId: 2, clientX: 300, clientY: 100, timeStamp: 40 }));
  canvas.emit('pointerup', pointer({ pointerId: 1, clientX: 100, clientY: 100, timeStamp: 50 }));
  expect(actions.release).not.toHaveBeenCalled();
});

test('the wheel zooms gently and keeps the page from scrolling', () => {
  const { canvas, actions } = setup();
  const event = canvas.emit('wheel', { deltaY: 100, deltaMode: 0 });
  expect(event.preventDefault).toHaveBeenCalled();
  // Deltas clamp to ±60 px before the exponential.
  expect(actions.zoom).toHaveBeenLastCalledWith(Math.exp(60 * 0.0022));
  canvas.emit('wheel', { deltaY: -1, deltaMode: 1 });
  expect(actions.zoom).toHaveBeenLastCalledWith(Math.exp(-16 * 0.0022));
});

test.each([
  ['ArrowLeft', 'orbit', [0.12, 0]],
  ['ArrowRight', 'orbit', [-0.12, 0]],
  ['ArrowUp', 'orbit', [0, 0.072]],
  ['ArrowDown', 'orbit', [0, -0.072]],
  ['+', 'zoom', [1 / 1.12]],
  ['=', 'zoom', [1 / 1.12]],
  ['-', 'zoom', [1.12]],
  ['Enter', 'release', []],
  ['b', 'releaseBatch', []],
  [' ', 'togglePause', []],
  ['.', 'step', []],
  ['r', 'reset', []],
  ['Home', 'resetView', []],
  ['0', 'resetView', []],
] as const)('%j runs %s', (key, action, args) => {
  const { canvas, actions } = setup();
  const event = canvas.emit('keydown', { key, repeat: false });
  const fn = actions[action] as ReturnType<typeof vi.fn>;
  expect(fn).toHaveBeenCalledOnce();
  if (args.length > 0) expect(fn.mock.calls[0]![0]).toBeCloseTo(args[0]!, 10);
  if (args.length > 1) expect(fn.mock.calls[0]![1]).toBeCloseTo(args[1]!, 10);
  expect(event.preventDefault).toHaveBeenCalled();
});

test('held one-shot keys fire once but still consume their repeats; other keys pass through', () => {
  const { canvas, actions } = setup();
  for (const key of ['Enter', ' ', 'b', 'r']) {
    const event = canvas.emit('keydown', { key, repeat: true });
    expect(event.preventDefault).toHaveBeenCalled();
  }
  expect(actions.release).not.toHaveBeenCalled();
  expect(actions.togglePause).not.toHaveBeenCalled();
  expect(actions.releaseBatch).not.toHaveBeenCalled();
  expect(actions.reset).not.toHaveBeenCalled();
  // Arrow repeats keep orbiting.
  canvas.emit('keydown', { key: 'ArrowLeft', repeat: true });
  expect(actions.orbit).toHaveBeenCalledOnce();

  const tab = canvas.emit('keydown', { key: 'Tab' });
  expect(tab.preventDefault).not.toHaveBeenCalled();
  const shortcut = canvas.emit('keydown', { key: 'r', metaKey: true });
  expect(shortcut.preventDefault).not.toHaveBeenCalled();
  expect(actions.reset).not.toHaveBeenCalled();
});

test('every handler runs through the guard', () => {
  const { canvas, guard } = setup();
  canvas.emit('pointerdown', pointer({}));
  canvas.emit('pointermove', pointer({ clientX: 5 }));
  canvas.emit('pointerup', pointer({}));
  canvas.emit('wheel', { deltaY: 1, deltaMode: 0 });
  canvas.emit('keydown', { key: 'Enter' });
  expect(guard).toHaveBeenCalledTimes(5);
});

test('dispose removes every listener and releases held pointers', () => {
  const { canvas, actions, input } = setup();
  expect(canvas.listenerCount).toBe(6);
  canvas.emit('pointerdown', pointer({}));
  expect(canvas.captured.size).toBe(1);
  input.dispose();
  expect(canvas.listenerCount).toBe(0);
  expect(canvas.captured.size).toBe(0);
  canvas.emit('keydown', { key: 'Enter' });
  expect(actions.release).not.toHaveBeenCalled();
});
