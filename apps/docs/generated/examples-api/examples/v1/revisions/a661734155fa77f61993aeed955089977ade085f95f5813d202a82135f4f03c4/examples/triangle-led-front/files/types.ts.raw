export type TriangleLedMode = -1 | 0 | 1 | 2;

export interface TriangleLedControls {
  readonly mode: TriangleLedMode;
}

export const DEFAULT_TRIANGLE_LED_CONTROLS: TriangleLedControls = { mode: -1 };

export function isTriangleLedMode(value: number): value is TriangleLedMode {
  return value === -1 || value === 0 || value === 1 || value === 2;
}
