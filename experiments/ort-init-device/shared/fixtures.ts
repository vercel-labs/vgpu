export const MODEL_FILE = "identity-1x1x4x4.onnx";
export const MODEL_SHA256 = "7764d8e16dff9245360a3dccbdbe7c545ccf52ddfcf0b22e0ef14f15d803e692";
export const DIMS = [1, 1, 4, 4] as const;
export const COUNT = 16;
export const INPUT = Float32Array.from({ length: COUNT }, (_, i) => i / 15);
export const EXPECTED = Array.from(INPUT, value => value * 2 + 0.25);
export async function verifyModel(bytes: Uint8Array) {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
  if (hash !== MODEL_SHA256) throw new Error(`model checksum mismatch: ${hash}`);
  return { file: MODEL_FILE, sha256: hash, bytes: bytes.byteLength };
}
export function numericMatch(actual: readonly number[]) {
  return actual.length === EXPECTED.length && actual.every((v, i) => Math.abs(v - EXPECTED[i]!) < 1e-5);
}
