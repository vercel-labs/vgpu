export interface PaintSegment {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly stroke: number;
}

export function installLightPaintInput(canvas: HTMLCanvasElement) {
  let activePointer = -1;
  let stroke = 0;
  let last: [number, number] = [0.5, 0.5];
  let pending:
    | { from: [number, number]; to: [number, number]; stroke: number }
    | undefined;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const point = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))
      ),
      Math.max(
        0,
        Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))
      ),
    ];
  };

  const extend = (from: [number, number], to: [number, number]) => {
    if (pending?.stroke === stroke) pending.to = to;
    else pending = { from, to, stroke };
  };

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== -1) return;
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers may not be capturable.
    }
    activePointer = event.pointerId;
    stroke++;
    last = point(event);
    extend(last, last);
  };

  const move = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerId !== activePointer) return;
    const next = point(event);
    extend(last, next);
    last = next;
  };

  const up = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerId !== activePointer) return;
    try {
      if (canvas.hasPointerCapture?.(activePointer)) {
        canvas.releasePointerCapture(activePointer);
      }
    } catch {
      // The browser may already have released capture.
    }
    activePointer = -1;
  };

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  return {
    take(): PaintSegment | undefined {
      const segment = pending;
      pending = undefined;
      return segment;
    },
    dispose() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      try {
        if (activePointer !== -1 && canvas.hasPointerCapture?.(activePointer)) {
          canvas.releasePointerCapture(activePointer);
        }
      } catch {
        // Continue restoring DOM state after a capture cleanup failure.
      }
      activePointer = -1;
      pending = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
