import { expect, test, vi } from 'vitest';
import { installPointerInput } from './pointer-input';

function setupCanvas() {
  const listeners = new Map<string, EventListener>();
  const captured = new Set<number>();
  const canvas = {
    style: { touchAction: 'pan-y' },
    getBoundingClientRect: () => ({ left: 20, top: 10, width: 400, height: 200 }),
    addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    setPointerCapture: vi.fn((pointerId: number) => captured.add(pointerId)),
    hasPointerCapture: vi.fn((pointerId: number) => captured.has(pointerId)),
    releasePointerCapture: vi.fn((pointerId: number) => captured.delete(pointerId)),
  } as unknown as HTMLCanvasElement;
  const pointer = (name: string, values: Partial<PointerEvent> = {}) => {
    listeners.get(name)?.({
      clientX: 220,
      clientY: 110,
      isPrimary: true,
      pointerId: 1,
      ...values,
    } as PointerEvent);
  };
  return { canvas, captured, listeners, pointer };
}

test('orbits, steers the light in canvas coordinates, and restores browser state', () => {
  const state = setupCanvas();
  const input = installPointerInput(state.canvas);
  state.pointer('pointermove', { clientX: 420, clientY: 10 });
  for (let index = 0; index < 40; index++) input.advance(0.05);
  expect(input.light.azimuth).toBeCloseTo(1.8, 1);
  expect(input.light.elevation).toBeCloseTo(1.15, 1);

  state.pointer('pointerdown');
  state.pointer('pointermove', { clientX: 250, clientY: 130 });
  input.advance(0.1);
  expect(input.camera.yaw).toBeGreaterThan(0.9);
  expect(input.camera.pitch).toBeGreaterThan(0.28);

  input.dispose();
  expect(state.listeners.size).toBe(0);
  expect(state.captured.size).toBe(0);
  expect(state.canvas.style.touchAction).toBe('pan-y');
});

test('lost pointer capture does not leave orbit input permanently locked', () => {
  const state = setupCanvas();
  const input = installPointerInput(state.canvas);
  state.pointer('pointerdown', { pointerId: 3 });
  state.pointer('lostpointercapture', { pointerId: 3 });
  state.pointer('pointerdown', { pointerId: 4 });

  expect(state.canvas.setPointerCapture).toHaveBeenNthCalledWith(1, 3);
  expect(state.canvas.setPointerCapture).toHaveBeenNthCalledWith(2, 4);
  input.dispose();
});
