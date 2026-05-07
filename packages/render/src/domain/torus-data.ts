import { pushVertex, toFlatTriangles, type StandardData } from "./primitive-data-utils.ts";

export interface TorusDataSpec {
  readonly radius: number;
  readonly tube: number;
  readonly radialSegments: number;
  readonly tubularSegments: number;
  readonly arc: number;
  readonly shading: "flat" | "smooth";
}

export function torusData(spec: TorusDataSpec): StandardData {
  const smooth = torusSmoothData(spec);
  return spec.shading === "flat" ? toFlatTriangles(smooth) : smooth;
}

function torusSmoothData(spec: TorusDataSpec): StandardData {
  const { radius, tube, radialSegments, tubularSegments, arc } = spec;
  const vertices: number[] = [];
  const indices: number[] = [];
  const row = radialSegments + 1;

  for (let j = 0; j <= tubularSegments; j++) {
    const u = j / tubularSegments;
    const ring = u * arc;
    const cosRing = Math.cos(ring);
    const sinRing = Math.sin(ring);
    for (let i = 0; i <= radialSegments; i++) {
      const v = i / radialSegments;
      const cross = v * Math.PI * 2;
      const cosTube = Math.cos(cross);
      const sinTube = Math.sin(cross);
      const x = (radius + tube * cosTube) * cosRing;
      const y = tube * sinTube;
      const z = (radius + tube * cosTube) * sinRing;
      pushVertex(vertices, x, y, z, cosTube * cosRing, sinTube, cosTube * sinRing, u, v);
    }
  }

  for (let j = 0; j < tubularSegments; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = j * row + i;
      const b = a + 1;
      const d = (j + 1) * row + i;
      const c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: vertices.length / 8 };
}
