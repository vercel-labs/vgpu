const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function shaderSourceChecksum(source: string): string {
  let hash = OFFSET_BASIS;
  for (let index = 0; index < source.length; index++) {
    const codeUnit = source.charCodeAt(index);
    hash = update(hash, codeUnit & 0xff);
    hash = update(hash, codeUnit >>> 8);
  }
  return `fnv1a64-utf16le-v1:${hash.toString(16).padStart(16, "0")}`;
}

function update(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte)) * PRIME) & MASK_64;
}
