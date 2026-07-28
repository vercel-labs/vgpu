export type SimulationTargetName = 'spectrum' | 'ping' | 'pong';

export interface IfftStage {
  readonly index: number;
  readonly axisStage: number;
  readonly horizontal: boolean;
  readonly subtransformSize: number;
  readonly input: SimulationTargetName;
  readonly output: Exclude<SimulationTargetName, 'spectrum'>;
}

export const OCEAN_RESOLUTION = 512 as const;
const AXIS_STAGES = 9;

/** The one immutable 18-pass Stockham table for the canonical 512² ocean. */
export function createIfftStageTable(): readonly IfftStage[] {
  const table: IfftStage[] = [];
  let input: SimulationTargetName = 'spectrum';
  let output: 'ping' | 'pong' = 'ping';
  for (const horizontal of [true, false]) {
    for (let axisStage = 0; axisStage < AXIS_STAGES; axisStage++) {
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
