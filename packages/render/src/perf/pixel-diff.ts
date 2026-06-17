import type { Texture } from "@vgpu/core";

export interface PixelDiffResult {
  /** Largest absolute per-byte difference (0–255). The headline: ≤1–2 is driver-rounding noise. */
  readonly maxByte: number;
  /** Mean absolute per-byte difference. */
  readonly meanByte: number;
  /** Bytes that differ at all. */
  readonly changedBytes: number;
  readonly totalBytes: number;
  /** changedBytes / totalBytes. A tiny fraction with maxByte ≤ ~2 means "imperceptible". */
  readonly changedFraction: number;
}

/**
 * Compares two renders byte-for-byte — the verify half of measure-before-keeping. Pass two
 * `Texture`s (read back via {@link Texture.read}) or two already-read `Uint8Array`s. Use it to
 * confirm an optimization is bit-exact (maxByte 0) or imperceptible (maxByte ≤ ~2 on a small
 * fraction) before keeping it.
 *
 * @example
 * const before = await renderInto(target);      // baseline texture
 * applyOptimization();
 * const after = await renderInto(target);
 * const { maxByte } = await pixelDiff(before, after);
 * expect(maxByte).toBeLessThanOrEqual(2);
 */
export async function pixelDiff(
  a: Texture | Uint8Array,
  b: Texture | Uint8Array,
): Promise<PixelDiffResult> {
  const da = a instanceof Uint8Array ? a : await a.read();
  const db = b instanceof Uint8Array ? b : await b.read();

  const total = Math.min(da.length, db.length);
  let maxByte = 0;
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < total; i++) {
    const d = Math.abs((da[i] ?? 0) - (db[i] ?? 0));
    if (d > 0) changed++;
    if (d > maxByte) maxByte = d;
    sum += d;
  }
  // A length mismatch is itself a difference; surface it rather than silently comparing a prefix.
  if (da.length !== db.length) maxByte = Math.max(maxByte, 255);

  return {
    maxByte,
    meanByte: total === 0 ? 0 : sum / total,
    changedBytes: changed,
    totalBytes: total,
    changedFraction: total === 0 ? 0 : changed / total,
  };
}
