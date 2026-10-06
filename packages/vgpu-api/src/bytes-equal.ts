/** Bitwise equality of two byte sequences (packed uniform values). */
export function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false;
  return true;
}
