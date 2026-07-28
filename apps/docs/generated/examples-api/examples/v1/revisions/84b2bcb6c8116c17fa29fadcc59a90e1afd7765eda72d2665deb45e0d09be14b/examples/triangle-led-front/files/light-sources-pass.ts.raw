import type { BrushSettings } from './settings';

export interface BrushState extends BrushSettings {
  x: number;
  y: number;
  active: boolean;
  /** Whether the pointer is inside the triangle hit area (hover state). */
  inside?: boolean;
  /** Whether the active pointer is a real mouse (pointerType === 'mouse'); gates the mouse-only proximity glow + lines-hover toggle. */
  isMouse?: boolean;
}

export interface SceneTunables {
  darkFloorAlbedo: number;
  lightFloorAlbedo: number;
  ledIntensity: number;
  noiseScale: number;
  rotationSpeed: number;
  brightnessMin: number;
  /** Dark-theme LED noise brightness floor; light uses `brightnessMin`. */
  brightnessMinDark: number;
  brightnessMax: number;
  /** Light-theme max LED intensity; dark uses `brightnessMax`. */
  brightnessMaxLight: number;
  ledHitThreshold: number;
  ledRaycastClipInsetPx: number;
}
