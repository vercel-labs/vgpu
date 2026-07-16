import { normalized, pushVertex, toFlatTriangles, type StandardData } from "./primitive-data-utils.ts";

export interface ConeDataSpec {
  readonly radius: number;
  readonly height: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
  readonly openEnded: boolean;
  readonly thetaStart: number;
  readonly thetaLength: number;
  readonly shading: "flat" | "smooth";
}

export function coneData(spec: ConeDataSpec): StandardData {
  const smooth = coneSmoothData(spec);
  return spec.shading === "flat" ? toFlatTriangles(smooth) : smooth;
}

function coneSmoothData(spec: ConeDataSpec): StandardData {
  const { radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength } = spec;
  const vertices: number[] = [];
  const indices: number[] = [];
  const row = radialSegments + 1;

  for (let j = 0; j <= heightSegments; j++) {
    const v = j / heightSegments;
    const y = -height / 2 + v * height;
    const r = radius * (1 - v);
    for (let i = 0; i <= radialSegments; i++) {
      const u = i / radialSegments;
      const theta = thetaStart + u * thetaLength;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const n = normalized(cos * height, radius, -sin * height);
      pushVertex(vertices, r * cos, y, -r * sin, n[0], n[1], n[2], u, v);
    }
  }

  for (let j = 0; j < heightSegments; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = j * row + i;
      const b = a + 1;
      const d = (j + 1) * row + i;
      const c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  if (!openEnded) addBaseCap(vertices, indices, spec);
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: vertices.length / 8 };
}

function addBaseCap(vertices: number[], indices: number[], spec: ConeDataSpec): void {
  const { radius, height, radialSegments, thetaStart, thetaLength } = spec;
  const center = vertices.length / 8;
  pushVertex(vertices, 0, -height / 2, 0, 0, -1, 0, 0.5, 0.5);
  const rim = vertices.length / 8;
  for (let i = 0; i <= radialSegments; i++) {
    const u = i / radialSegments;
    const theta = thetaStart + u * thetaLength;
    const x = Math.cos(theta);
    const z = -Math.sin(theta);
    pushVertex(vertices, radius * x, -height / 2, radius * z, 0, -1, 0, 0.5 + 0.5 * x, 0.5 - 0.5 * z);
  }
  for (let i = 0; i < radialSegments; i++) indices.push(center, rim + i + 1, rim + i);
}
