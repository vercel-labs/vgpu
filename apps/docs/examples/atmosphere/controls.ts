import GUI from 'lil-gui';
import { TONEMAPS, type AtmosphereState } from './tuning';

export interface AtmosphereControls {
  readonly host: HTMLElement;
  getState(): AtmosphereState;
  setFps(fps: number): void;
  dispose(): void;
}

/** Container-scoped lil-gui panel plus drag-to-look on the canvas. */
export function installControls(canvas: HTMLCanvasElement, initial: AtmosphereState): AtmosphereControls {
  const state: AtmosphereState = { ...initial };
  const parent = canvas.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  const gui = new GUI({ title: 'Atmosphere & Clouds', container: parent ?? undefined, width: 260 });
  Object.assign(gui.domElement.style, { position: 'absolute', top: '16px', right: '16px', zIndex: '2' });
  gui.domElement.title = 'Drag the canvas to look around';

  gui.add(state, 'sunElevation', -12, 90, 0.1).name('Sun elevation (°)');
  gui.add(state, 'sunAzimuth', -180, 180, 1).name('Sun azimuth (°)');
  gui.add(state, 'altitudeKm', 0, 4, 0.001).name('Altitude (km)');
  gui.add(state, 'exposureEv', -2, 12, 0.1).name('Exposure (EV)');
  gui.add(state, 'haze', 0.25, 8, 0.01).name('Haze (×)');
  gui.add(state, 'cloudCoverage', 0, 1, 0.01).name('Cloud coverage');
  gui.add(state, 'cloudDetail', 0, 1.5, 0.01).name('Cloud detail (×)');
  gui.add(state, 'cloudType', -1, 1, 0.01).name('Cloud type').domElement.title = '-1: stratus, 0: mixed, 1: cumulus';
  gui.add(state, 'cloudSeed', 0, 20, 1).name('Weather seed');
  gui.add(state, 'tonemap', Object.fromEntries(TONEMAPS.map((name) => [name.toUpperCase(), name]))).name('Tonemap');
  gui.add(state, 'cloudShadows').name('Cloud shadows');
  const fps = gui.add({ fps: 0 }, 'fps').name('FPS').decimals(0).disable();

  let dragging: { x: number; y: number; yaw: number; pitch: number } | undefined;
  const onDown = (event: PointerEvent) => {
    dragging = { x: event.clientX, y: event.clientY, yaw: state.yaw, pitch: state.pitch };
    canvas.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    const scale = 90 / Math.max(1, canvas.clientHeight);
    state.yaw = dragging.yaw - (event.clientX - dragging.x) * scale;
    state.pitch = Math.max(-89, Math.min(89, dragging.pitch + (event.clientY - dragging.y) * scale));
  };
  const onUp = () => { dragging = undefined; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return {
    host: gui.domElement,
    getState: () => ({ ...state }),
    setFps(value) { fps.setValue(Math.round(value)); },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      gui.destroy();
    },
  };
}
