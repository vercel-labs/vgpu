import { normalized, pushVertex, toFlatTriangles, type StandardData } from "./primitive-data-utils.ts";

export interface CylinderDataSpec {
  readonly radiusTop: number;
  readonly radiusBottom: number;
  readonly height: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
  readonly openEnded: boolean;
  readonly thetaStart: number;
  readonly thetaLength: number;
  readonly shading: "flat" | "smooth";
}

export function cylinderData(spec: CylinderDataSpec): StandardData {
  const smooth = cylinderSmoothData(spec);
  return spec.shading === "flat" ? toFlatTriangles(smooth) : smooth;
}

function cylinderSmoothData(spec: CylinderDataSpec): StandardData {
  const vertices: number[] = [];
  const indices: number[] = [];
  const { radialSegments, heightSegments, radiusTop, radiusBottom, height, thetaStart, thetaLength } = spec;
  const row = radialSegments + 1;
  for (let j = 0; j <= heightSegments; j++) {
    const v = j / heightSegments;
    const y = -height / 2 + v * height;
    const r = radiusBottom + (radiusTop - radiusBottom) * v;
    for (let i = 0; i <= radialSegments; i++) {
      const u = i / radialSegments;
      const theta = thetaStart + u * thetaLength;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const n = normalized(cos * height, radiusBottom - radiusTop, -sin * height);
      pushVertex(vertices, r * cos, y, -r * sin, n[0], n[1], n[2], u, v);
    }
  }
  for (let j = 0; j < heightSegments; j++) for (let i = 0; i < radialSegments; i++) {
    const a = j * row + i;
    const b = a + 1;
    const d = (j + 1) * row + i;
    const c = d + 1;
    indices.push(a, b, d, b, c, d);
  }
  if (!spec.openEnded) {
    if (radiusTop > 0) addCap(vertices, indices, spec, "top");
    if (radiusBottom > 0) addCap(vertices, indices, spec, "bottom");
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: vertices.length / 8 };
}

function addCap(vertices: number[], indices: number[], spec: CylinderDataSpec, cap: "top" | "bottom"): void {
  const { radialSegments, thetaStart, thetaLength } = spec;
  const top = cap === "top";
  const y = top ? spec.height / 2 : -spec.height / 2;
  const radius = top ? spec.radiusTop : spec.radiusBottom;
  const center = vertices.length / 8;
  pushVertex(vertices, 0, y, 0, 0, top ? 1 : -1, 0, 0.5, 0.5);
  const rim = vertices.length / 8;
  for (let i = 0; i <= radialSegments; i++) {
    const u = i / radialSegments;
    const theta = thetaStart + u * thetaLength;
    const x = Math.cos(theta);
    const z = -Math.sin(theta);
    pushVertex(vertices, radius * x, y, radius * z, 0, top ? 1 : -1, 0, 0.5 + 0.5 * x, 0.5 - 0.5 * z);
  }
  for (let i = 0; i < radialSegments; i++) indices.push(center, top ? rim + i : rim + i + 1, top ? rim + i + 1 : rim + i);
}
