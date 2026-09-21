import {
  DEFAULT_PITCH,
  DEFAULT_RADIUS,
  DEFAULT_YAW,
  clampPitch,
  clampRadius,
} from './camera';

const ORBIT_SPEED = 0.006;
const DOLLY_SPEED = 0.0016;
const CAMERA_EASE = 14;
const LIGHT_EASE = 5;
const LIGHT_HOLD_SECONDS = 2.5;

export function installPointerInput(canvas: HTMLCanvasElement) {
  let targetYaw = DEFAULT_YAW;
  let targetPitch = DEFAULT_PITCH;
  let targetRadius = DEFAULT_RADIUS;
  let yaw = targetYaw;
  let pitch = targetPitch;
  let radius = targetRadius;
  let targetLightAzimuth = 0.9;
  let targetLightElevation = 0.5;
  let lightAzimuth = targetLightAzimuth;
  let lightElevation = targetLightElevation;
  let hoverRemaining = 0;
  let elapsed = 0;
  let activePointer: number | undefined;
  let previousX = 0;
  let previousY = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const steerLight = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    targetLightAzimuth = (x - 0.5) * 3.6;
    targetLightElevation = 0.15 + (1 - y) * 1.0;
    hoverRemaining = LIGHT_HOLD_SECONDS;
  };

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    previousX = event.clientX;
    previousY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };

  const move = (event: PointerEvent) => {
    if (activePointer === undefined) {
      steerLight(event);
      return;
    }
    if (event.pointerId !== activePointer) return;
    targetYaw += (event.clientX - previousX) * ORBIT_SPEED;
    targetPitch = clampPitch(targetPitch + (event.clientY - previousY) * ORBIT_SPEED);
    previousX = event.clientX;
    previousY = event.clientY;
  };

  const finishDrag = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = undefined;
  };

  const lostCapture = (event: PointerEvent) => {
    if (event.pointerId === activePointer) activePointer = undefined;
  };

  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    targetRadius = clampRadius(targetRadius * Math.exp(event.deltaY * DOLLY_SPEED));
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move, { passive: true });
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  canvas.addEventListener('lostpointercapture', lostCapture);
  canvas.addEventListener('wheel', wheel, { passive: false });

  return {
    get camera() {
      return { yaw, pitch, radius };
    },
    get light() {
      return { azimuth: lightAzimuth, elevation: lightElevation };
    },
    advance(deltaTime: number) {
      const dt = Math.max(0, Math.min(0.1, deltaTime));
      elapsed += dt;
      hoverRemaining = Math.max(0, hoverRemaining - dt);
      if (hoverRemaining === 0) {
        targetLightAzimuth = 0.9 + Math.sin(elapsed * 0.23) * 1.6;
        targetLightElevation = 0.45 + Math.sin(elapsed * 0.37) * 0.3;
      }
      const cameraBlend = 1 - Math.exp(-CAMERA_EASE * dt);
      const lightBlend = 1 - Math.exp(-LIGHT_EASE * dt);
      yaw += (targetYaw - yaw) * cameraBlend;
      pitch += (targetPitch - pitch) * cameraBlend;
      radius += (targetRadius - radius) * cameraBlend;
      lightAzimuth += (targetLightAzimuth - lightAzimuth) * lightBlend;
      lightElevation += (targetLightElevation - lightElevation) * lightBlend;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', finishDrag);
      canvas.removeEventListener('pointercancel', finishDrag);
      canvas.removeEventListener('lostpointercapture', lostCapture);
      canvas.removeEventListener('wheel', wheel);
      if (activePointer !== undefined && canvas.hasPointerCapture(activePointer)) {
        canvas.releasePointerCapture(activePointer);
      }
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
