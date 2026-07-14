import { pushVertex, toFlatTriangles, type StandardData } from "./primitive-data-utils.ts";

export interface CapsuleDataSpec {
  readonly radius: number;
  readonly height: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
  readonly shading: "flat" | "smooth";
}

export function capsuleData(spec: CapsuleDataSpec): StandardData {
  const smooth = capsuleSmoothData(spec);
  return spec.shading === "flat" ? toFlatTriangles(smooth) : smooth;
}

function capsuleSmoothData(spec: CapsuleDataSpec): StandardData {
  const vertices: number[] = [];
  const indices: number[] = [];
  const rows = 3 * spec.heightSegments + 1;
  const total = spec.height + Math.PI * spec.radius;
  for (let row = 0; row < rows; row++) addRow(vertices, spec, row, total);
  const stride = spec.radialSegments + 1;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < spec.radialSegments; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const d = (j + 1) * stride + i;
      const c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: vertices.length / 8 };
}

function addRow(vertices: number[], spec: CapsuleDataSpec, row: number, total: number): void {
  const { radius, height, radialSegments, heightSegments } = spec;
  const bottomEnd = heightSegments;
  const cylinderEnd = bottomEnd + heightSegments;
  let y = 0;
  let ringRadius = radius;
  let ny = 0;
  let vDistance = 0;
  if (row <= bottomEnd) {
    const angle = -Math.PI / 2 + (row / heightSegments) * (Math.PI / 2);
    ringRadius = radius * Math.cos(angle);
    y = -height / 2 + radius * Math.sin(angle);
    ny = row === 0 ? -1 : Math.sin(angle);
    vDistance = (angle + Math.PI / 2) * radius;
  } else if (row <= cylinderEnd) {
    const t = (row - bottomEnd) / heightSegments;
    y = -height / 2 + t * height;
    vDistance = Math.PI * radius / 2 + t * height;
  } else {
    const angle = ((row - cylinderEnd) / heightSegments) * (Math.PI / 2);
    ringRadius = radius * Math.cos(angle);
    y = height / 2 + radius * Math.sin(angle);
    ny = row === 3 * heightSegments ? 1 : Math.sin(angle);
    vDistance = Math.PI * radius / 2 + height + angle * radius;
  }
  const radial = Math.sqrt(Math.max(0, 1 - ny * ny));
  for (let i = 0; i <= radialSegments; i++) {
    const u = i / radialSegments;
    const theta = u * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    pushVertex(vertices, ringRadius * cos, y, -ringRadius * sin, radial * cos, ny, -radial * sin, u, total > 0 ? vDistance / total : 0);
  }
}
