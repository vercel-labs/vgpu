export type Mat4 = Float32Array;

export interface OrbitOptions {
  readonly radius?: number;
  readonly height?: number;
  readonly speed?: number;
}

/** Returns a column-major model matrix orbiting around the Y axis using explicit JS time. */
export function orbit(time: number, options: OrbitOptions = {}): Mat4 {
  const angle = time * (options.speed ?? 1);
  const radius = options.radius ?? 1;
  const y = options.height ?? 0;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    c * radius, y, s * radius, 1,
  ]);
}
