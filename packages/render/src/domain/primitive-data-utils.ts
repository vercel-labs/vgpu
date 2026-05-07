export interface StandardData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
  readonly vertexCount: number;
}

export function pushVertex(out: number[], x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void {
  out.push(x, y, z, nx, ny, nz, u, v);
}

export function normalized(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

export function toFlatTriangles(source: StandardData): StandardData {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < source.indices.length; i += 3) {
    const ia = source.indices[i]! * 8;
    const ib = source.indices[i + 1]! * 8;
    const ic = source.indices[i + 2]! * 8;
    const normal = triangleNormal(source.vertices, ia, ib, ic);
    const base = vertices.length / 8;
    copyWithNormal(vertices, source.vertices, ia, normal);
    copyWithNormal(vertices, source.vertices, ib, normal);
    copyWithNormal(vertices, source.vertices, ic, normal);
    indices.push(base, base + 1, base + 2);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: vertices.length / 8 };
}

function triangleNormal(data: Float32Array, ia: number, ib: number, ic: number): readonly [number, number, number] {
  const abx = data[ib]! - data[ia]!;
  const aby = data[ib + 1]! - data[ia + 1]!;
  const abz = data[ib + 2]! - data[ia + 2]!;
  const acx = data[ic]! - data[ia]!;
  const acy = data[ic + 1]! - data[ia + 1]!;
  const acz = data[ic + 2]! - data[ia + 2]!;
  return normalized(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
}

function copyWithNormal(out: number[], data: Float32Array, offset: number, normal: readonly [number, number, number]): void {
  out.push(data[offset]!, data[offset + 1]!, data[offset + 2]!, normal[0], normal[1], normal[2], data[offset + 6]!, data[offset + 7]!);
}
