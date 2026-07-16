export interface RingDataSpec {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly segments: number;
  readonly thetaStart: number;
  readonly thetaLength: number;
}

export interface RingData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

export function ringData(spec: RingDataSpec): RingData {
  const { innerRadius, outerRadius, segments, thetaStart, thetaLength } = spec;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const theta = thetaStart + (i / segments) * thetaLength;
    const x = Math.cos(theta);
    const z = -Math.sin(theta);
    pushVertex(vertices, innerRadius, outerRadius, x, z);
    pushVertex(vertices, outerRadius, outerRadius, x, z);
  }

  for (let i = 0; i < segments; i++) {
    const inner = i * 2;
    const outer = inner + 1;
    const nextInner = inner + 2;
    const nextOuter = inner + 3;
    indices.push(inner, outer, nextInner, outer, nextOuter, nextInner);
  }

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function pushVertex(out: number[], radius: number, outerRadius: number, x: number, z: number): void {
  out.push(radius * x, 0, radius * z, 0, 1, 0, 0.5 + (radius / outerRadius) * 0.5 * x, 0.5 - (radius / outerRadius) * 0.5 * z);
}
