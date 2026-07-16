export interface DiskDataSpec {
  readonly radius: number;
  readonly segments: number;
  readonly thetaStart: number;
  readonly thetaLength: number;
}

export interface DiskData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

const TWO_PI = Math.PI * 2;

export function diskData(spec: DiskDataSpec): DiskData {
  const { radius, segments, thetaStart, thetaLength } = spec;
  const vertices: number[] = [0, 0, 0, 0, 1, 0, 0.5, 0.5];
  const indices: number[] = [];
  const closed = Math.abs(thetaLength - TWO_PI) < 1e-12;
  const rimCount = closed ? segments : segments + 1;

  for (let i = 0; i < rimCount; i++) {
    const t = closed ? i / segments : i / (rimCount - 1);
    const theta = thetaStart + t * thetaLength;
    const x = Math.cos(theta);
    const z = -Math.sin(theta);
    vertices.push(radius * x, 0, radius * z, 0, 1, 0, 0.5 + 0.5 * x, 0.5 - 0.5 * z);
  }

  for (let i = 0; i < segments; i++) {
    const next = closed && i === segments - 1 ? 1 : i + 2;
    indices.push(0, i + 1, next);
  }

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}
