export function scaledSize(
  width: number,
  height: number,
  requestedScale: number,
  maxEdge: number
): readonly [number, number] {
  const scale = Math.min(requestedScale, maxEdge / Math.max(width, height, 1));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
