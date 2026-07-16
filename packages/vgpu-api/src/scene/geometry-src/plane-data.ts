export interface PlaneDataSpec {
  readonly width: number;
  readonly height: number;
  readonly widthSegments: number;
  readonly heightSegments: number;
}

export interface PlaneData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

export function planeData(spec: PlaneDataSpec): PlaneData {
  const { width, height, widthSegments, heightSegments } = spec;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= heightSegments; j++) {
    const v = j / heightSegments;
    const z = -height / 2 + v * height;
    for (let i = 0; i <= widthSegments; i++) {
      const u = i / widthSegments;
      vertices.push(-width / 2 + u * width, 0, z, 0, 1, 0, u, v);
    }
  }

  const row = widthSegments + 1;
  for (let j = 0; j < heightSegments; j++) {
    for (let i = 0; i < widthSegments; i++) {
      const a = j * row + i;
      const b = a + 1;
      const d = (j + 1) * row + i;
      const c = d + 1;
      indices.push(a, d, b, b, d, c);
    }
  }

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}
