import { type Buffer, type Device } from 'vgpu';
import {
  HERO_STATE_MODES,
  LEDS_PER_EDGE,
  triangleAnchorIndices,
  triangleEdgeLedLayout,
  type HeroStateMode,
  type HeroStateSettings,
  type RenderSize,
} from './settings';
import { type SceneTunables } from './passes/light-sources-pass';
import { valueNoise2D } from './value-noise';

const LED_FLOATS = 8;
const POS_BRIGHTNESS_OFFSET = 0;
const COLOR_OFFSET = 4;
const LED_COUNT = LEDS_PER_EDGE * 3;
const PULSE_FLOOR = 0.08;
const PULSE_HALF_EDGE = LEDS_PER_EDGE / 2;
const PULSE_ANCHORS = triangleAnchorIndices(LEDS_PER_EDGE);
const PULSE_VERTICES = PULSE_ANCHORS.vertices;
const PULSE_MIDPOINTS = PULSE_ANCHORS.midpoints;
const PULSE_VERTEX_HOLD_END = 1 / 44;
const PULSE_SPLIT_END = 21 / 44;
const PULSE_MIDPOINT_HOLD_END = 23 / 44;
const PULSE_ROTATE_END = 43 / 44;
const PULSE_ROTATE_DIRECTION = 1;
const PULSE_CENTERS_SCRATCH = new Float32Array(6);
const SCAN_RED_ENDPOINT = new Float32Array(3);
const SCAN_BLUE_ENDPOINT = new Float32Array(3);

export interface LedBufferState {
  data: Float32Array;
  currentState: Float32Array;
  targetState: Float32Array;
  local: Float32Array;
  buffer: Buffer;
  ledRadius: number;
  triangleHeight: number;
  lastMode: HeroStateMode | undefined;
  transitionStart: number;
  transitionDuration: number;
  transitionActive: boolean;
}

export interface LedTransitionFrame {
  mode: HeroStateMode;
  modeChanged: boolean;
  progress: number;
  easedProgress: number;
  active: boolean;
}

export function createLedBuffer(
  device: Device,
  size: RenderSize,
): LedBufferState {
  const layout = triangleEdgeLedLayout(size, LEDS_PER_EDGE);
  const data = new Float32Array(layout.positions.length * LED_FLOATS);
  const currentState = new Float32Array(data.length);
  const targetState = new Float32Array(data.length);
  const local = new Float32Array(layout.positions.length * 2);
  for (const [i, p] of layout.positions.entries()) {
    const base = i * LED_FLOATS;
    const x = p.x;
    const y = p.y;
    const angle = p.angle ?? 0;
    data[base + POS_BRIGHTNESS_OFFSET] = x;
    data[base + POS_BRIGHTNESS_OFFSET + 1] = y;
    data[base + POS_BRIGHTNESS_OFFSET + 2] = 0;
    data[base + POS_BRIGHTNESS_OFFSET + 3] = angle;
    data[base + COLOR_OFFSET] = 1;
    data[base + COLOR_OFFSET + 1] = 1;
    data[base + COLOR_OFFSET + 2] = 1;
    data[base + COLOR_OFFSET + 3] = 0;
    local[i * 2] = x - layout.center.x;
    local[i * 2 + 1] = y - layout.center.y;
  }
  currentState.set(data);
  targetState.set(data);
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: ['storage', 'copy_dst'],
    label: 'triangle-led-4-leds',
  });
  buffer.write(data);
  return {
    data,
    currentState,
    targetState,
    local,
    buffer,
    ledRadius: layout.ledRadius,
    triangleHeight: layout.geometry.height,
    lastMode: undefined,
    transitionStart: 0,
    transitionDuration: 0,
    transitionActive: false,
  };
}

export function updateLeds(
  device: Device,
  leds: LedBufferState,
  time: number,
  tunables: SceneTunables,
  settings: HeroStateSettings,
): LedTransitionFrame {
  let modeChanged = false;
  if (leds.lastMode === undefined) {
    leds.lastMode = settings.mode;
    leds.transitionActive = false;
  } else if (settings.mode !== leds.lastMode) {
    modeChanged = true;
    leds.currentState.set(leds.data);
    leds.transitionStart = time;
    leds.transitionDuration = Math.max(0, settings.transitionDuration);
    leds.transitionActive = leds.transitionDuration > 0;
    leds.lastMode = settings.mode;
  }

  switch (settings.mode) {
    case HERO_STATE_MODES.scan:
      updateScan(
        leds,
        leds.targetState,
        time,
        settings.scanSpeed,
        settings.scanHeadWidth,
        settings.scanRedShift,
        settings.scanBlueShift,
        settings.scanHueRotationSpeed,
      );
      break;
    case HERO_STATE_MODES.pulse:
      updatePulse(
        leds,
        leds.targetState,
        time,
        settings.pulseSpeed,
        settings.pulseWidth,
      );
      break;
    case HERO_STATE_MODES.coding:
    default:
      updateCoding(leds, leds.targetState, time, tunables);
      break;
  }

  let progress = 1;
  let easedProgress = 1;
  if (leds.transitionActive) {
    progress = clamp01((time - leds.transitionStart) / leds.transitionDuration);
    easedProgress = easeInOutCubic(progress);
    lerpLedState(leds.data, leds.currentState, leds.targetState, easedProgress);
    if (progress >= 1) leds.transitionActive = false;
  } else {
    leds.data.set(leds.targetState);
  }

  device.queue.writeBuffer(leds.buffer.gpu, 0, leds.data.buffer as ArrayBuffer);
  return {
    mode: settings.mode,
    modeChanged,
    progress,
    easedProgress,
    active: leds.transitionActive,
  };
}

function updateCoding(
  leds: LedBufferState,
  target: Float32Array,
  time: number,
  tunables: SceneTunables,
) {
  const rot = time * tunables.rotationSpeed;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  for (let i = 0; i < leds.local.length / 2; i++) {
    const x = leds.local[i * 2] ?? 0;
    const y = leds.local[i * 2 + 1] ?? 0;
    const rx = (x * cosR - y * sinR) * tunables.noiseScale;
    const ry = (x * sinR + y * cosR) * tunables.noiseScale;
    writeLed(target, i, clamp01(valueNoise2D(rx, ry) + 0.2), 1, 1, 1);
  }
}

function updateScan(
  leds: LedBufferState,
  target: Float32Array,
  time: number,
  speed: number,
  headWidth: number,
  redShift: number,
  blueShift: number,
  hueRotationSpeed: number,
) {
  const headPos = fract(time * speed) * LED_COUNT;
  const width = Math.max(0.001, headWidth);
  const huePhase = fract(time * hueRotationSpeed);
  hslToRgb(SCAN_RED_ENDPOINT, huePhase, 1, 0.5);
  hslToRgb(SCAN_BLUE_ENDPOINT, fract(huePhase + 2 / 3), 1, 0.5);

  for (let i = 0; i < LED_COUNT; i++) {
    const signedOffset = signedWrappedDistance(i, headPos, LED_COUNT);
    const d = Math.abs(signedOffset);
    const envelope = smoothstep(width, 0, d);
    const brightness = Math.max(envelope, PULSE_FLOOR);
    const tintMask = smoothstep(0.001, 0.05, envelope);
    const local = clamp01(signedOffset / width / 2 + 0.5) * 2 - 1;
    const redSide = Math.sqrt(Math.max(0, -local));
    const blueSide = Math.sqrt(Math.max(0, local));
    const redStrength = clamp01(redShift) * redSide;
    const blueStrength = clamp01(blueShift) * blueSide;

    let r = mix(1, SCAN_RED_ENDPOINT[0] ?? 1, redStrength);
    let g = mix(1, SCAN_RED_ENDPOINT[1] ?? 1, redStrength);
    let b = mix(1, SCAN_RED_ENDPOINT[2] ?? 1, redStrength);
    r = mix(r, SCAN_BLUE_ENDPOINT[0] ?? 1, blueStrength);
    g = mix(g, SCAN_BLUE_ENDPOINT[1] ?? 1, blueStrength);
    b = mix(b, SCAN_BLUE_ENDPOINT[2] ?? 1, blueStrength);

    writeLed(
      target,
      i,
      brightness,
      mix(1, r, tintMask),
      mix(1, g, tintMask),
      mix(1, b, tintMask),
    );
  }
}

function updatePulse(
  leds: LedBufferState,
  target: Float32Array,
  time: number,
  speed: number,
  width: number,
) {
  const progress = fract(time * speed);
  const pulseCenterCount = pulseCentersForProgress(progress);
  const sigma = Math.max(0.001, width);

  for (let i = 0; i < LED_COUNT; i++) {
    let brightness = PULSE_FLOOR;
    for (let j = 0; j < pulseCenterCount; j++) {
      const center = PULSE_CENTERS_SCRATCH[j] ?? 0;
      const d = wrappedDistance(i, center, LED_COUNT);
      brightness = Math.max(brightness, Math.exp(-((d / sigma) ** 2)));
    }
    writeLed(target, i, clamp01(brightness), 1, 1, 1);
  }
}

function pulseCentersForProgress(progress: number) {
  if (progress < PULSE_VERTEX_HOLD_END || progress >= PULSE_ROTATE_END) {
    PULSE_CENTERS_SCRATCH[0] = PULSE_VERTICES[0];
    PULSE_CENTERS_SCRATCH[1] = PULSE_VERTICES[1];
    PULSE_CENTERS_SCRATCH[2] = PULSE_VERTICES[2];
    return 3;
  }

  if (progress < PULSE_SPLIT_END) {
    const t = easeInOutCubic(
      (progress - PULSE_VERTEX_HOLD_END) /
        (PULSE_SPLIT_END - PULSE_VERTEX_HOLD_END),
    );
    const offset = PULSE_HALF_EDGE * t;
    PULSE_CENTERS_SCRATCH[0] = wrapIndex(PULSE_VERTICES[0] + offset);
    PULSE_CENTERS_SCRATCH[1] = wrapIndex(PULSE_VERTICES[0] - offset);
    PULSE_CENTERS_SCRATCH[2] = wrapIndex(PULSE_VERTICES[1] - offset);
    PULSE_CENTERS_SCRATCH[3] = wrapIndex(PULSE_VERTICES[1] + offset);
    PULSE_CENTERS_SCRATCH[4] = wrapIndex(PULSE_VERTICES[2] - offset);
    PULSE_CENTERS_SCRATCH[5] = wrapIndex(PULSE_VERTICES[2] + offset);
    return 6;
  }

  if (progress < PULSE_MIDPOINT_HOLD_END) {
    PULSE_CENTERS_SCRATCH[0] = PULSE_MIDPOINTS[0];
    PULSE_CENTERS_SCRATCH[1] = PULSE_MIDPOINTS[1];
    PULSE_CENTERS_SCRATCH[2] = PULSE_MIDPOINTS[2];
    return 3;
  }

  const t = easeOutQuart(
    (progress - PULSE_MIDPOINT_HOLD_END) /
      (PULSE_ROTATE_END - PULSE_MIDPOINT_HOLD_END),
  );
  const offset = PULSE_ROTATE_DIRECTION * PULSE_HALF_EDGE * t;
  PULSE_CENTERS_SCRATCH[0] = wrapIndex(PULSE_MIDPOINTS[0] + offset);
  PULSE_CENTERS_SCRATCH[1] = wrapIndex(PULSE_MIDPOINTS[1] + offset);
  PULSE_CENTERS_SCRATCH[2] = wrapIndex(PULSE_MIDPOINTS[2] + offset);
  return 3;
}

function lerpLedState(
  target: Float32Array,
  from: Float32Array,
  to: Float32Array,
  t: number,
) {
  for (let i = 0; i < target.length; i++) {
    const a = from[i] ?? 0;
    target[i] = a + ((to[i] ?? 0) - a) * t;
  }
}

function writeLed(
  target: Float32Array,
  i: number,
  brightness: number,
  r: number,
  g: number,
  b: number,
) {
  const base = i * LED_FLOATS;
  target[base + 2] = brightness;
  target[base + COLOR_OFFSET] = r;
  target[base + COLOR_OFFSET + 1] = g;
  target[base + COLOR_OFFSET + 2] = b;
}

function hslToRgb(target: Float32Array, h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  target[0] = hslChannel(h, a, l, 0);
  target[1] = hslChannel(h, a, l, 8);
  target[2] = hslChannel(h, a, l, 4);
}

function hslChannel(h: number, a: number, l: number, n: number) {
  const k = (n + h * 12) % 12;
  return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
}

function fract(value: number) {
  return value - Math.floor(value);
}

function wrappedDistance(a: number, b: number, period: number) {
  const d = Math.abs(a - b);
  return Math.min(d, period - d);
}

function signedWrappedDistance(a: number, b: number, period: number) {
  return ((((a - b) % period) + period + period / 2) % period) - period / 2;
}

function wrapIndex(value: number) {
  return ((value % LED_COUNT) + LED_COUNT) % LED_COUNT;
}

function easeInOutCubic(t: number) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function easeOutQuart(t: number) {
  const x = clamp01(t);
  return 1 - (1 - x) ** 4;
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
