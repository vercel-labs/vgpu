export interface PaintSegment {
  /** Normalised canvas coordinates, y downwards — the same space the shaders use. */
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** Index of the stroke this segment belongs to; the palette is keyed on it. */
  readonly stroke: number;
}

export interface LightPaintInput {
  readonly pressed: boolean;
  /** Strokes started since the input was installed. */
  readonly strokes: number;
  /**
   * The segment painted since the last call, or `undefined` when the pointer is idle.
   *
   * Several pointer events inside one frame are coalesced into a single capsule from the
   * first `from` to the last `to`: the paint pass rasterises whole segments, so a fast
   * drag leaves a continuous streak instead of a dotted line, and one pass per frame is
   * enough to keep up with a 60 Hz pointer.
   */
  take(): PaintSegment | undefined;
  dispose(): void;
}

export function installLightPaintInput(canvas: HTMLCanvasElement): LightPaintInput {
  let pressed = false;
  let activePointerId = -1;
  let strokes = 0;
  let pending: { from: [number, number]; to: [number, number]; stroke: number } | undefined;
  let last: [number, number] = [0.5, 0.5];
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const point = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    ];
  };

  const extend = (from: [number, number], to: [number, number]) => {
    if (pending && pending.stroke === strokes) pending.to = to;
    else pending = { from, to, stroke: strokes };
  };

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || pressed) return;
    // Capture keeps a drag alive past the canvas edge. It throws for a pointer id the
    // browser does not consider active — a synthetic event from a test, for instance — and
    // that must not abort the stroke.
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
    activePointerId = event.pointerId;
    pressed = true;
    strokes++;
    last = point(event);
    // A click with no movement still paints: the segment is a dot of the stroke radius.
    extend(last, last);
  };

  const move = (event: PointerEvent) => {
    // Hover never paints — light only appears while the pointer is pressed.
    if (!pressed || !event.isPrimary || event.pointerId !== activePointerId) return;
    const next = point(event);
    extend(last, next);
    last = next;
  };

  const up = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerId !== activePointerId) return;
    try {
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch { /* already released */ }
    pressed = false;
    activePointerId = -1;
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  return {
    get pressed() { return pressed; },
    get strokes() { return strokes; },
    take() {
      const segment = pending;
      pending = undefined;
      return segment;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (pressed && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      pressed = false;
      pending = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
