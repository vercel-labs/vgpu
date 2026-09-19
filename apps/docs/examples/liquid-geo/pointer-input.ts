export interface ShapeInput {
  readonly position: readonly [number, number];
  readonly strength: number;
  update(): void;
  dispose(): void;
}

export function normalizePointer(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">
): [number, number] {
  const x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
  const y = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
  return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
}

export function installShapeInput(canvas: HTMLCanvasElement): ShapeInput {
  let x = 0;
  let y = 0;
  let targetX = 0;
  let targetY = 0;
  let strength = 0;
  let targetStrength = 0;
  let capturedPointer: number | undefined;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const moveTo = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    [targetX, targetY] = normalizePointer(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect()
    );
    targetStrength = 1;
  };
  const enter = (event: PointerEvent) => moveTo(event);
  const move = (event: PointerEvent) => moveTo(event);
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || capturedPointer !== undefined) return;
    capturedPointer = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    moveTo(event);
  };
  const release = (event: PointerEvent) => {
    if (!event.isPrimary || capturedPointer !== event.pointerId) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    capturedPointer = undefined;
    targetStrength = 0;
  };
  const leave = () => {
    if (capturedPointer === undefined) targetStrength = 0;
  };

  canvas.addEventListener("pointerenter", enter);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", leave);

  return {
    get position() {
      return [x, y] as const;
    },
    get strength() {
      return strength;
    },
    update() {
      x += (targetX - x) * 0.11;
      y += (targetY - y) * 0.11;
      strength +=
        (targetStrength - strength) *
        (targetStrength > strength ? 0.13 : 0.075);
      if (Math.abs(strength) < 0.0001) strength = 0;
    },
    dispose() {
      canvas.removeEventListener("pointerenter", enter);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", release);
      canvas.removeEventListener("pointercancel", release);
      canvas.removeEventListener("pointerleave", leave);
      if (
        capturedPointer !== undefined &&
        canvas.hasPointerCapture?.(capturedPointer)
      ) {
        canvas.releasePointerCapture(capturedPointer);
      }
      capturedPointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
