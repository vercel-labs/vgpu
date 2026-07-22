export type SimulationTargetName = 'spectrum' | 'ping' | 'pong';

export interface IfftStage {
  readonly index: number;
  readonly axisStage: number;
  readonly horizontal: boolean;
  readonly subtransformSize: number;
  readonly input: SimulationTargetName;
  readonly output: Exclude<SimulationTargetName, 'spectrum'>;
}

/** Explicit Stockham identity table. Every row maps to one immutable effect. */
export function createIfftStageTable(resolution: number): readonly IfftStage[] {
  const stages = Math.log2(resolution);
  if (!Number.isInteger(stages)) throw new Error(`FFT resolution must be a power of two, got ${resolution}`);
  const table: IfftStage[] = [];
  let input: SimulationTargetName = 'spectrum';
  let output: 'ping' | 'pong' = 'ping';
  for (const horizontal of [true, false]) {
    for (let axisStage = 0; axisStage < stages; axisStage++) {
      table.push(Object.freeze({
        index: table.length,
        axisStage,
        horizontal,
        subtransformSize: 2 ** (axisStage + 1),
        input,
        output,
      }));
      input = output;
      output = output === 'ping' ? 'pong' : 'ping';
    }
  }
  return Object.freeze(table);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateOceanNoise(resolution: number, seed = 0x6f636561): Float32Array<ArrayBuffer> {
  const out = new Float32Array(resolution * resolution * 4) as Float32Array<ArrayBuffer>;
  const random = mulberry32(seed);
  for (let i = 0; i < out.length; i += 2) {
    const u1 = Math.max(random(), Number.MIN_VALUE);
    const u2 = random();
    const magnitude = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    out[i] = magnitude * Math.cos(angle);
    out[i + 1] = magnitude * Math.sin(angle);
  }
  return out;
}
