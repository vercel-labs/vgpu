import { expect, test, vi } from 'vitest';

import { installOrbitInput } from './input';

function canvasDouble() {
  const listeners = new Map<string, (event: unknown) => void>();
  const canvas = {
    addEventListener: vi.fn((name: string, listener: (event: unknown) => void, init?: AddEventListenerOptions) => {
      listeners.set(name, listener);
      init?.signal?.addEventListener('abort', () => listeners.delete(name));
    }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const fire = (name: string, event: Record<string, unknown>) => listeners.get(name)?.({ preventDefault: vi.fn(), ...event });
  return { canvas, listeners, fire };
}

test('one pointer orbits; two pointers pinch-zoom instead', () => {
  const { canvas, fire } = canvasDouble();
  const handlers = { orbit: vi.fn(), zoom: vi.fn() };
  const input = installOrbitInput(canvas, handlers);
  fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
  expect(input.dragging).toBe(true);
  fire('pointermove', { pointerId: 1, clientX: 150, clientY: 90 });
  expect(handlers.orbit).toHaveBeenCalledWith(-50 * 0.006, -10 * 0.006);

  fire('pointerdown', { pointerId: 2, clientX: 250, clientY: 90 });
  fire('pointermove', { pointerId: 2, clientX: 350, clientY: 90 });
  // The fingers spread from 100 to 200 px: half the distance, closer.
  expect(handlers.zoom).toHaveBeenCalledWith(0.5);
  expect(handlers.orbit).toHaveBeenCalledOnce();

  fire('pointerup', { pointerId: 1 });
  fire('pointerup', { pointerId: 2 });
  expect(input.dragging).toBe(false);
});

test('only the primary mouse button orbits', () => {
  const { canvas, fire } = canvasDouble();
  const handlers = { orbit: vi.fn(), zoom: vi.fn() };
  const input = installOrbitInput(canvas, handlers);
  fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 0, clientY: 0 });
  fire('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
  expect(input.dragging).toBe(false);
  expect(handlers.orbit).not.toHaveBeenCalled();
  fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 });
  fire('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
  expect(handlers.orbit).toHaveBeenCalledOnce();
});

test('wheel and keys zoom and orbit; modified keys are left to the browser', () => {
  const { canvas, fire } = canvasDouble();
  const handlers = { orbit: vi.fn(), zoom: vi.fn() };
  installOrbitInput(canvas, handlers);
  const wheel = { deltaY: 1000, deltaMode: 0, preventDefault: vi.fn() };
  fire('wheel', wheel);
  expect(wheel.preventDefault).toHaveBeenCalled();
  // Large deltas are clamped, so one flick cannot jump the camera.
  expect(handlers.zoom).toHaveBeenLastCalledWith(Math.exp(60 * 0.0022));

  fire('keydown', { key: 'ArrowLeft' });
  expect(handlers.orbit).toHaveBeenLastCalledWith(0.12, 0);
  fire('keydown', { key: '+' });
  expect(handlers.zoom).toHaveBeenLastCalledWith(1 / 1.12);
  const modified = { key: 'ArrowRight', metaKey: true, preventDefault: vi.fn() };
  fire('keydown', modified);
  expect(modified.preventDefault).not.toHaveBeenCalled();
  expect(handlers.orbit).toHaveBeenCalledOnce();
});

test('dispose removes every listener and releases held pointers', () => {
  const { canvas, listeners, fire } = canvasDouble();
  const input = installOrbitInput(canvas, { orbit: vi.fn(), zoom: vi.fn() });
  fire('pointerdown', { pointerId: 7, clientX: 0, clientY: 0 });
  input.dispose();
  expect(listeners.size).toBe(0);
  expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
  expect(input.dragging).toBe(false);
});
