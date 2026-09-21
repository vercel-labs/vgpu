const fract = (value: number): number => value - Math.floor(value);

export const clamp01 = (value: number): number =>
  Math.min(1, Math.max(0, value));

export function smoothstep(
  edge0: number,
  edge1: number,
  value: number
): number {
  const unit = clamp01((value - edge0) / Math.max(edge1 - edge0, 1e-8));
  return unit * unit * (3 - 2 * unit);
}

function hash(x: number, y: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.545_312_3);
}

export function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(0, 1, fract(x));
  const fy = smoothstep(0, 1, fract(y));
  const top = hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx;
  const bottom = hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

export function fbm(x: number, y: number, octaves = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave++) {
    value += noise(x * frequency, y * frequency) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return value / weight;
}

export function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSquared = abx * abx + aby * aby || 1;
  const t = clamp01(((x - ax) * abx + (y - ay) * aby) / lengthSquared);
  return Math.hypot(x - (ax + abx * t), y - (ay + aby * t));
}

export function triangleDistance(
  x: number,
  y: number,
  vertices: readonly (readonly [number, number])[]
): number {
  const distances = vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length]!;
    return segmentDistance(x, y, start[0], start[1], end[0], end[1]);
  });
  return Math.min(...distances);
}

export function triangleContains(
  x: number,
  y: number,
  vertices: readonly (readonly [number, number])[]
): boolean {
  let orientation = 0;
  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index]!;
    const end = vertices[(index + 1) % vertices.length]!;
    const cross =
      (end[0] - start[0]) * (y - start[1]) -
      (end[1] - start[1]) * (x - start[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const side = Math.sign(cross);
    if (orientation !== 0 && side !== orientation) return false;
    orientation = side;
  }
  return true;
}

export function writePixel(
  pixels: Uint8Array,
  index: number,
  rgba: readonly [number, number, number, number]
): void {
  for (let channel = 0; channel < 4; channel++) {
    pixels[index + channel] = Math.round(clamp01(rgba[channel]!) * 255);
  }
}
