import {
  LANDMARK_SIZE,
  MCP_LANDMARKS,
  NUM_LANDMARKS,
} from "./hand-model-contract";
import type { HandRoi, Vec2 } from "./hand-pipeline";

export const FIXTURE_FRAME_WIDTH = 640;
export const FIXTURE_FRAME_HEIGHT = 360;
export const SYNTHETIC_FRAME_COUNT = 24;
export const SYNTHETIC_DT = 1 / 30;

function hash2(x: number, y: number): number {
  let hash = (x * 374_761_393 + y * 668_265_263) | 0;
  hash = (hash ^ (hash >>> 13)) * 1_274_126_177;
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4_294_967_295;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function disc(
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
  aspect: number
): number {
  const distance = Math.hypot((x - cx) * aspect, y - cy);
  return smoothstep(radius, radius * 0.35, distance);
}

export function createFixtureFrame(
  width = FIXTURE_FRAME_WIDTH,
  height = FIXTURE_FRAME_HEIGHT
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const aspect = width / height;
  const ringCx = width * 0.5;
  const ringCy = height * 0.52;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      let luma = 0.1;
      luma += 0.2 * disc(u, v, 0.34, 0.44, 0.26, aspect);
      luma += 0.26 * disc(u, v, 0.63, 0.6, 0.2, aspect);
      luma += 0.12 * disc(u, v, 0.79, 0.29, 0.13, aspect);
      const distance = Math.hypot(x + 0.5 - ringCx, y + 0.5 - ringCy);
      luma += 0.085 * Math.sin((distance / 15) * Math.PI * 2);
      const value = Math.min(
        255,
        Math.max(0, Math.round((luma + (hash2(x, y) - 0.5) * 0.012) * 255))
      );
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

const RAW_HAND: readonly (readonly [number, number])[] = [
  [0.5, 0.88],
  [0.34, 0.78],
  [0.26, 0.68],
  [0.2, 0.6],
  [0.15, 0.53],
  [0.4, 0.5],
  [0.38, 0.38],
  [0.37, 0.3],
  [0.36, 0.23],
  [0.5, 0.48],
  [0.5, 0.35],
  [0.5, 0.26],
  [0.5, 0.19],
  [0.6, 0.5],
  [0.61, 0.37],
  [0.62, 0.29],
  [0.63, 0.22],
  [0.7, 0.54],
  [0.72, 0.44],
  [0.73, 0.37],
  [0.74, 0.31],
];

function canonicalHandLandmarks(): readonly Vec2[] {
  let cx = 0;
  let cy = 0;
  for (const index of MCP_LANDMARKS) {
    cx += RAW_HAND[index]![0];
    cy += RAW_HAND[index]![1];
  }
  cx /= MCP_LANDMARKS.length;
  cy /= MCP_LANDMARKS.length;
  return RAW_HAND.map(([x, y]) => ({ x: x - cx + 0.5, y: y - cy + 0.5 }));
}

function syntheticHandPath(slot: number, count: number): readonly Vec2[] {
  const path: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const wave = Math.sin(t * Math.PI * 1.6);
    path.push(
      slot === 0
        ? { x: 0.32 + 0.36 * t, y: 0.28 + 0.12 * wave }
        : { x: 0.68 - 0.36 * t, y: 0.78 - 0.12 * wave }
    );
  }
  return path;
}

function syntheticPresence(index: number, count: number): number {
  if (index === 0) return 0.52;
  const t = count === 1 ? 1 : index / (count - 1);
  return 0.55 + 0.2 * Math.sin(t * Math.PI);
}

function tangent(path: readonly Vec2[], index: number): Vec2 {
  const a = path[Math.max(0, index - 1)]!;
  const b = path[Math.min(path.length - 1, index + 1)]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return length > 1e-6 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
}

export interface SyntheticHandResult {
  readonly slot: number;
  readonly roi: HandRoi;
  readonly landmarks: Float32Array;
  readonly presence: number;
}

export interface SyntheticHandFrame {
  readonly results: readonly SyntheticHandResult[];
}

export function syntheticHandFrames(
  sourceWidth = FIXTURE_FRAME_WIDTH,
  sourceHeight = FIXTURE_FRAME_HEIGHT,
  count = SYNTHETIC_FRAME_COUNT
): readonly SyntheticHandFrame[] {
  const canonical = canonicalHandLandmarks();
  const size = Math.min(sourceWidth, sourceHeight) * 0.34;
  const paths = [syntheticHandPath(0, count), syntheticHandPath(1, count)];
  const frames: SyntheticHandFrame[] = [];

  for (let index = 0; index < count; index++) {
    const results: SyntheticHandResult[] = [];
    for (let slot = 0; slot < paths.length; slot++) {
      const path = paths[slot]!;
      const expected = path[index]!;
      const centre = {
        x: (1 - expected.x) * sourceWidth,
        y: expected.y * sourceHeight,
      };
      const direction = tangent(path, index);
      const roi: HandRoi = {
        cx: centre.x,
        cy: centre.y,
        size,
        rotation: Math.atan2(direction.y, -direction.x),
      };
      const landmarks = new Float32Array(NUM_LANDMARKS * 3);
      for (let point = 0; point < NUM_LANDMARKS; point++) {
        const value = canonical[point]!;
        landmarks[point * 3] = value.x * LANDMARK_SIZE;
        landmarks[point * 3 + 1] = value.y * LANDMARK_SIZE;
        landmarks[point * 3 + 2] = (value.y - 0.5) * 0.1 * LANDMARK_SIZE;
      }
      results.push({
        slot,
        roi,
        landmarks,
        presence: syntheticPresence(index, count),
      });
    }
    frames.push({ results });
  }
  return frames;
}
