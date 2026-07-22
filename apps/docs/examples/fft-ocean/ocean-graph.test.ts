import { describe, expect, it } from 'vitest';
import { createIfftStageTable, generateOceanNoise } from './ocean-graph';

describe('FFT ocean graph', () => {
  it('builds immutable ping/pong stages with correct final parity', () => {
    const table = createIfftStageTable(512);
    expect(table).toHaveLength(18);
    expect(table.map((stage) => stage.subtransformSize)).toEqual([
      2, 4, 8, 16, 32, 64, 128, 256, 512,
      2, 4, 8, 16, 32, 64, 128, 256, 512,
    ]);
    expect(table.slice(0, 9).every((stage) => stage.horizontal)).toBe(true);
    expect(table.slice(9).every((stage) => !stage.horizontal)).toBe(true);
    expect(table.every((stage) => stage.input !== stage.output)).toBe(true);
    expect(table.at(-1)?.output).toBe('pong');
  });

  it('generates repeatable asymmetric gaussian noise', () => {
    const a = generateOceanNoise(8, 0x6f636561);
    const b = generateOceanNoise(8, 0x6f636561);
    expect(a).toEqual(b);
    expect(new Set(a.slice(0, 32))).not.toHaveLength(1);
  });

  it('rejects non-power-of-two resolutions', () => {
    expect(() => createIfftStageTable(48)).toThrow(/power of two/);
  });
});
