export interface StirInput {
  active: boolean;
  from: [number, number];
  to: [number, number];
  velocity: [number, number];
  stroke: number;
  consumeStep(): void;
  dispose(): void;
}

export function installStirInput(canvas: HTMLCanvasElement, showOverlay = true): StirInput {
  let pressed = false;
  let from: [number, number] = [.5, .5];
  let to: [number, number] = [.5, .5];
  let velocity: [number, number] = [0, 0];
  let lastTime = 0;
  let decay = 0;
  let stroke = 0;
  const previousTouchAction = canvas.style.touchAction;
  const parent = canvas.parentElement;
  const previousParentPosition = parent?.style.position ?? '';
  let changedParentPosition = false;
  canvas.style.touchAction = 'none';

  const overlay = showOverlay ? document.createElement('div') : undefined;
  if (overlay) {
    overlay.textContent = 'move to stir';
    Object.assign(overlay.style, { position: 'absolute', left: '50%', bottom: '18px', transform: 'translateX(-50%)', color: 'rgba(255,255,255,.8)', font: '500 12px system-ui', letterSpacing: '.08em', textTransform: 'uppercase', pointerEvents: 'none', transition: 'opacity 400ms', zIndex: '2' });
    if (parent) { if (getComputedStyle(parent).position === 'static') { parent.style.position = 'relative'; changedParentPosition = true; } parent.append(overlay); }
  }

  const point = (event: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - r.left) / Math.max(1, r.width))), Math.max(0, Math.min(1, 1 - (event.clientY - r.top) / Math.max(1, r.height)))];
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    canvas.setPointerCapture(event.pointerId);
    pressed = true;
    stroke++;
    from = to = point(event);
    lastTime = event.timeStamp;
    velocity = [0, 0];
    decay = 2;
    if (overlay) overlay.style.opacity = '0';
  };
  const move = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const next = point(event);
    if (lastTime === 0) {
      from = to = next;
      lastTime = event.timeStamp;
      return;
    }
    const dt = Math.max(0.004, Math.min(0.05, (event.timeStamp - lastTime) / 1000));
    from = to;
    to = next;
    velocity = [
      Math.max(-2.5, Math.min(2.5, (to[0] - from[0]) / dt)),
      Math.max(-2.5, Math.min(2.5, (to[1] - from[1]) / dt)),
    ];
    lastTime = event.timeStamp;
    decay = 2;
    if (overlay) overlay.style.opacity = '0';
  };
  const up = (event: PointerEvent) => { if (event.isPrimary) { pressed = false; decay = 2; } };
  const leave = () => { if (!pressed) { lastTime = 0; decay = 0; } };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('pointerleave', leave);

  return {
    get active() { return pressed || decay > 0; }, get from() { return from; }, get to() { return to; }, get velocity() { return velocity; }, get stroke() { return stroke; },
    consumeStep() { from = to; if (!pressed && decay > 0) { velocity = [velocity[0] * .45, velocity[1] * .45]; decay--; } },
    dispose() { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('pointerleave', leave); overlay?.remove(); canvas.style.touchAction = previousTouchAction; if (changedParentPosition && parent) parent.style.position = previousParentPosition; },
  };
}
