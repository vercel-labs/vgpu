import { deflateRawSync } from "node:zlib";

export interface ZipFile {
  readonly name: string;
  readonly content: string | Uint8Array;
}

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const DOS_DATE_1980_01_01 = 0x0021;

const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafeName(name: string): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe ZIP entry name: ${name}`);
  }
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function createZip(files: readonly ZipFile[]): Uint8Array<ArrayBuffer> {
  if (files.length > 0xffff) throw new Error("ZIP contains too many files");

  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localLength = 0;
  let centralLength = 0;

  for (const file of files) {
    assertSafeName(file.name);
    const name = encoder.encode(file.name);
    const content = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);

    if (name.byteLength > 0xffff) throw new Error(`ZIP entry name is too long: ${file.name}`);
    if (content.byteLength > 0xffffffff || compressed.byteLength > 0xffffffff) {
      throw new Error(`ZIP entry is too large: ${file.name}`);
    }

    const localHeader = new Uint8Array(30);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, DEFLATE_METHOD, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, DOS_DATE_1980_01_01, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, compressed.byteLength, true);
    local.setUint32(22, content.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    local.setUint16(28, 0, true);
    localChunks.push(localHeader, name, compressed);

    const centralHeader = new Uint8Array(46);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_FLAG, true);
    central.setUint16(10, DEFLATE_METHOD, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, DOS_DATE_1980_01_01, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, compressed.byteLength, true);
    central.setUint32(24, content.byteLength, true);
    central.setUint16(28, name.byteLength, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, localLength, true);
    centralChunks.push(centralHeader, name);

    localLength += localHeader.byteLength + name.byteLength + compressed.byteLength;
    centralLength += centralHeader.byteLength + name.byteLength;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralLength, true);
  endView.setUint32(16, localLength, true);
  endView.setUint16(20, 0, true);

  return concatenate(
    [...localChunks, ...centralChunks, end],
    localLength + centralLength + end.byteLength,
  );
}
