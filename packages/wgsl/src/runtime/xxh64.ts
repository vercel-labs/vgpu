const mask = (1n << 64n) - 1n;
const p1 = 11400714785074694791n, p2 = 14029467366897019727n, p3 = 1609587929392839161n;
const p4 = 9650029242287828579n, p5 = 2870177450012600261n;

export function xxh64(text: string, seed = 0n): string {
  const input = new TextEncoder().encode(text);
  let index = 0;
  let h: bigint;
  if (input.length >= 32) {
    let v1 = seed + p1 + p2, v2 = seed + p2, v3 = seed, v4 = seed - p1;
    const limit = input.length - 32;
    do {
      v1 = round(v1, lane(input, index)); index += 8;
      v2 = round(v2, lane(input, index)); index += 8;
      v3 = round(v3, lane(input, index)); index += 8;
      v4 = round(v4, lane(input, index)); index += 8;
    } while (index <= limit);
    h = rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n);
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = seed + p5;
  h = (h + BigInt(input.length)) & mask;
  while (index + 8 <= input.length) { h ^= round(0n, lane(input, index)); h = (rotl(h, 27n) * p1 + p4) & mask; index += 8; }
  if (index + 4 <= input.length) { h ^= u32(input, index) * p1 & mask; h = (rotl(h, 23n) * p2 + p3) & mask; index += 4; }
  while (index < input.length) { h ^= BigInt(input[index]!) * p5 & mask; h = rotl(h, 11n) * p1 & mask; index++; }
  h ^= h >> 33n; h = h * p2 & mask; h ^= h >> 29n; h = h * p3 & mask; h ^= h >> 32n;
  return h.toString(16).padStart(16, "0");
}

function round(acc: bigint, laneValue: bigint): bigint { return rotl((acc + laneValue * p2) & mask, 31n) * p1 & mask; }
function merge(acc: bigint, value: bigint): bigint { acc ^= round(0n, value); return (acc * p1 + p4) & mask; }
function rotl(x: bigint, bits: bigint): bigint { return ((x << bits) | (x >> (64n - bits))) & mask; }
function lane(input: Uint8Array, index: number): bigint { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(input[index + i]!); return v; }
function u32(input: Uint8Array, index: number): bigint { return BigInt(input[index]!) | BigInt(input[index + 1]!) << 8n | BigInt(input[index + 2]!) << 16n | BigInt(input[index + 3]!) << 24n; }
