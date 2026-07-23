export interface Orbit { yaw: number; pitch: number }

export function createRenderScheduler(
  render: () => void,
  raf: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let pending: number | null = null;
  let disposed = false;
  return {
    request() {
      if (disposed || pending !== null) return;
      pending = raf(() => {
        pending = null;
        if (!disposed) render();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}

export function installDragOrbit(canvas: HTMLCanvasElement, orbit: Orbit, requestRender: () => void): () => void {
  let activeId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activeId !== null) return;
    activeId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== activeId) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx === 0 && dy === 0) return;
    orbit.yaw -= dx * 0.006;
    orbit.pitch = Math.max(-1.15, Math.min(1.15, orbit.pitch + dy * 0.006));
    requestRender();
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== activeId) return;
    activeId = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return () => {
    if (activeId !== null && canvas.hasPointerCapture(activeId)) canvas.releasePointerCapture(activeId);
    activeId = null;
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', end);
    canvas.removeEventListener('pointercancel', end);
    canvas.style.touchAction = previousTouchAction;
  };
}
