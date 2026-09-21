import { isUtf8 } from "node:buffer";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";

export const graphLimits = { moduleBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, modules: 1024, depth: 128, manifestBytes: 1024 * 1024 } as const;

/** Nonblocking open lets us reject a FIFO/device before attempting its first read. */
export async function readShaderSource(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const label = `Shader source ${path}`;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new TypeError(`${label} must be a regular file`);
    const reader = new BoundedText(label, graphLimits.moduleBytes);
    reader.checkSize(stat.size);
    for (;;) {
      signal?.throwIfAborted();
      const chunk = reader.chunk();
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) return reader.text();
      reader.append(chunk.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
}

/** Only vgpu's own manifest reads use this seam; Node/PnP resolver hooks keep their policy. */
export function readShaderPackageManifest(path: string, signal?: AbortSignal): string {
  signal?.throwIfAborted();
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const label = `Package manifest ${path}`;
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new TypeError(`${label} must be a regular file`);
    const reader = new BoundedText(label, graphLimits.manifestBytes);
    reader.checkSize(stat.size);
    for (;;) {
      signal?.throwIfAborted();
      const chunk = reader.chunk();
      const length = readSync(file, chunk, 0, chunk.length, null);
      if (length === 0) return reader.text();
      reader.append(chunk.subarray(0, length));
    }
  } finally { closeSync(file); }
}

class BoundedText {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  private readonly label: string;
  private readonly maximum: number;

  constructor(label: string, maximum: number) { this.label = label; this.maximum = maximum; }
  checkSize(size: number): void {
    if (size > this.maximum) throw new RangeError(`${this.label} exceeds ${this.maximum / (1024 * 1024)} MiB`);
  }
  chunk(): Buffer { return Buffer.allocUnsafe(Math.min(64 * 1024, this.maximum + 1 - this.length)); }
  append(chunk: Buffer): void {
    this.length += chunk.length;
    this.checkSize(this.length);
    this.chunks.push(chunk);
  }
  text(): string {
    const bytes = Buffer.concat(this.chunks, this.length);
    if (!isUtf8(bytes) || bytes.includes(0)) throw new TypeError(`${this.label} must be valid UTF-8 without NUL bytes`);
    return bytes.toString("utf8");
  }
}
