// DOM glue: dragging rotates the field, hovering feeds the repel simulation,
// arrow keys nudge the rotation, releasing lets it spring back.

import type { Animation } from './animation';

const DRAG_RADIANS_PER_PIXEL = 0.005;
const KEY_STEP = 0.08;

export interface FieldInput {
  dispose(): void;
}

function isMouseLike(event: PointerEvent): boolean {
  return event.isPrimary && (event.pointerType === 'mouse' || event.pointerType === 'pen');
}

export function installFieldInput(canvas: HTMLCanvasElement, animation: Animation): FieldInput {
  let drag: { id: number; x: number; y: number } | undefined;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const pointerNdc = (event: { clientX: number; clientY: number }): [number, number] | undefined => {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return undefined;
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((event.clientY - rect.top) / rect.height) * 2,
    ];
  };

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || drag !== undefined) return;
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      return;
    }
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const ndc = pointerNdc(event);
    if (ndc) animation.setPointer(ndc[0], ndc[1], true);
  };

  const move = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (drag) {
      if (event.pointerId !== drag.id) return;
      animation.rotate(
        (event.clientY - drag.y) * DRAG_RADIANS_PER_PIXEL,
        (event.clientX - drag.x) * DRAG_RADIANS_PER_PIXEL,
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
      const ndc = pointerNdc(event);
      if (ndc) animation.setPointer(ndc[0], ndc[1], true);
      return;
    }
    // Hover repel is a mouse gesture; touch never hovers.
    if (!isMouseLike(event) || event.buttons !== 0) return;
    const ndc = pointerNdc(event);
    if (ndc) animation.setPointer(ndc[0], ndc[1], false);
  };

  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = undefined;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    animation.release();
    const ndc = isMouseLike(event) ? pointerNdc(event) : undefined;
    if (ndc && Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1) animation.setPointer(ndc[0], ndc[1], false);
    else animation.clearPointer();
  };

  const leave = (event: PointerEvent) => {
    if (event.isPrimary && !drag) animation.clearPointer();
  };

  const keydown = (event: KeyboardEvent) => {
    const step =
      event.key === 'ArrowDown' ? [KEY_STEP, 0]
      : event.key === 'ArrowUp' ? [-KEY_STEP, 0]
      : event.key === 'ArrowRight' ? [0, KEY_STEP]
      : event.key === 'ArrowLeft' ? [0, -KEY_STEP]
      : undefined;
    if (!step) return;
    event.preventDefault();
    animation.rotate(step[0]!, step[1]!);
  };

  const keyup = (event: KeyboardEvent) => {
    if (event.key.startsWith('Arrow')) animation.release();
  };

  const blur = () => {
    drag = undefined;
    animation.clearPointer();
    animation.release();
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('keydown', keydown);
  canvas.addEventListener('keyup', keyup);
  canvas.addEventListener('blur', blur);

  return {
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', finish);
      canvas.removeEventListener('pointercancel', finish);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('keydown', keydown);
      canvas.removeEventListener('keyup', keyup);
      canvas.removeEventListener('blur', blur);
      if (drag !== undefined && canvas.hasPointerCapture?.(drag.id)) canvas.releasePointerCapture(drag.id);
      drag = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
