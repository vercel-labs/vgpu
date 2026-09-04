import { CAMERA_TUNING, TONEMAPS, type AtmosphereState, type Tonemap } from './tuning';

export interface AtmosphereControls {
  readonly host: HTMLElement;
  getState(): AtmosphereState;
  /** Shows the measured frame rate next to the hint line. */
  setFps(fps: number): void;
  dispose(): void;
}

interface SliderDef { key: 'sunElevation' | 'sunAzimuth' | 'altitudeKm' | 'exposureEv' | 'haze' | 'cloudCoverage' | 'cloudDetail' | 'cloudType' | 'cloudSeed'; label: string; min: number; max: number; step: number; format: (value: number) => string; log?: boolean }

const SLIDERS: readonly SliderDef[] = [
  { key: 'sunElevation', label: 'Sun elevation', min: -12, max: 90, step: 0.1, format: (v) => `${v.toFixed(1)}°` },
  { key: 'sunAzimuth', label: 'Sun azimuth', min: -180, max: 180, step: 1, format: (v) => `${v.toFixed(0)}°` },
  { key: 'altitudeKm', label: 'Altitude', min: 0.002, max: CAMERA_TUNING.maxAltitudeKm, step: 0.001, log: true, format: (v) => (v < 1 ? `${(v * 1000).toFixed(0)} m` : `${v.toFixed(1)} km`) },
  { key: 'exposureEv', label: 'Exposure', min: -2, max: 12, step: 0.1, format: (v) => `${v.toFixed(1)} EV` },
  { key: 'haze', label: 'Haze', min: 0.25, max: 8, step: 0.01, log: true, format: (v) => `${v.toFixed(2)}×` },
  { key: 'cloudCoverage', label: 'Cloud coverage', min: 0, max: 1, step: 0.01, format: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'cloudDetail', label: 'Cloud detail', min: 0, max: 1.5, step: 0.01, format: (v) => `${v.toFixed(2)}×` },
  { key: 'cloudType', label: 'Cloud type', min: -1, max: 1, step: 0.01, format: (v) => (v < -0.33 ? 'stratus' : v > 0.33 ? 'cumulus' : 'mixed') },
  { key: 'cloudSeed', label: 'Weather seed', min: 0, max: 20, step: 1, format: (v) => `#${v.toFixed(0)}` },
];

/** Slider panel plus drag-to-look on the canvas. */
export function installControls(canvas: HTMLCanvasElement, initial: AtmosphereState): AtmosphereControls {
  const state: AtmosphereState = { ...initial };
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'absolute', top: '16px', right: '16px', zIndex: '2', display: 'grid', gap: '8px', padding: '12px', minWidth: '220px',
    border: '1px solid rgba(255, 255, 255, 0.18)', borderRadius: '16px',
    background: 'linear-gradient(180deg, rgba(5, 8, 22, 0.78), rgba(5, 8, 22, 0.48))', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
    backdropFilter: 'blur(10px)', pointerEvents: 'auto', color: 'white',
    font: '600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', userSelect: 'none',
  });

  for (const def of SLIDERS) {
    const row = document.createElement('label');
    Object.assign(row.style, { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 8px', alignItems: 'center' });
    const text = document.createElement('span');
    text.textContent = def.label;
    const value = document.createElement('span');
    Object.assign(value.style, { opacity: '0.8', fontVariantNumeric: 'tabular-nums' });
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.log ? Math.log(def.min) : def.min);
    input.max = String(def.log ? Math.log(def.max) : def.max);
    input.step = def.log ? '0.01' : String(def.step);
    input.value = String(def.log ? Math.log(state[def.key]) : state[def.key]);
    input.setAttribute('aria-label', def.label);
    Object.assign(input.style, { gridColumn: '1 / -1', accentColor: '#ffb86b', width: '100%', margin: '0' });
    value.textContent = def.format(state[def.key]);
    input.addEventListener('input', () => {
      const raw = Number(input.value);
      state[def.key] = def.log ? Math.exp(raw) : raw;
      value.textContent = def.format(state[def.key]);
    });
    row.append(text, value, input);
    host.append(row);
  }

  const tonemapRow = document.createElement('label');
  Object.assign(tonemapRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' });
  const tonemapText = document.createElement('span');
  tonemapText.textContent = 'Tonemap';
  const select = document.createElement('select');
  Object.assign(select.style, { background: 'rgba(255,255,255,0.08)', color: 'white', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '4px 8px', font: 'inherit' });
  for (const name of TONEMAPS) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name.toUpperCase();
    option.selected = name === state.tonemap;
    select.append(option);
  }
  select.addEventListener('change', () => { state.tonemap = select.value as Tonemap; });
  tonemapRow.append(tonemapText, select);
  host.append(tonemapRow);

  const shadowsRow = document.createElement('label');
  Object.assign(shadowsRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' });
  const shadowsText = document.createElement('span');
  shadowsText.textContent = 'Cloud shadows';
  const shadows = document.createElement('input');
  shadows.type = 'checkbox';
  shadows.checked = state.cloudShadows;
  shadows.setAttribute('aria-label', 'Cloud shadows');
  shadows.style.accentColor = '#ffb86b';
  shadows.addEventListener('change', () => { state.cloudShadows = shadows.checked; });
  shadowsRow.append(shadowsText, shadows);
  host.append(shadowsRow);

  const hint = document.createElement('div');
  Object.assign(hint.style, { display: 'flex', justifyContent: 'space-between', opacity: '0.6', fontWeight: '500' });
  const hintText = document.createElement('span');
  hintText.textContent = 'Drag to look around';
  const fps = document.createElement('span');
  fps.style.fontVariantNumeric = 'tabular-nums';
  fps.dataset['atmosphereFps'] = '';
  hint.append(hintText, fps);
  host.append(hint);

  const parent = canvas.parentElement;
  if (parent) {
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.append(host);
  } else {
    document.body.append(host);
  }

  let dragging: { x: number; y: number; yaw: number; pitch: number } | undefined;
  const onDown = (event: PointerEvent) => {
    dragging = { x: event.clientX, y: event.clientY, yaw: state.yaw, pitch: state.pitch };
    canvas.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    const scale = 90 / Math.max(1, canvas.clientHeight);
    state.yaw = dragging.yaw + (event.clientX - dragging.x) * scale;
    state.pitch = Math.max(-89, Math.min(89, dragging.pitch + (event.clientY - dragging.y) * scale));
  };
  const onUp = () => { dragging = undefined; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return {
    host,
    getState: () => ({ ...state }),
    setFps(value) { fps.textContent = `${value.toFixed(0)} fps`; },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      host.remove();
    },
  };
}
