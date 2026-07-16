export interface SphereDataSpec {
  readonly radius: number;
  readonly widthSegments: number;
  readonly heightSegments: number;
}

export interface SphereData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

export function sphereData(spec: SphereDataSpec): SphereData {
  const { radius, widthSegments, heightSegments } = spec;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= heightSegments; j++) {
    const v = j / heightSegments;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let i = 0; i <= widthSegments; i++) {
      const u = i / widthSegments;
      const phi = u * Math.PI * 2;
      const nx = sinTheta * Math.cos(phi);
      const ny = cosTheta;
      const nz = sinTheta * Math.sin(phi);
      vertices.push(radius * nx, radius * ny, radius * nz, nx, ny, nz, u, v);
    }
  }

  const row = widthSegments + 1;
  for (let j = 0; j < heightSegments; j++) {
    for (let i = 0; i < widthSegments; i++) {
      const a = j * row + i;
      const b = a + 1;
      const d = (j + 1) * row + i;
      const c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}
