import type { Buffer } from "./buffer.ts";
import type { Device } from "./device.ts";
import type { Texture } from "./texture.ts";
import type { BufferOptions, TextureOptions } from "./types.ts";

export interface PingPongCore<T extends { destroy(): void }> {
  readonly read: T;
  readonly write: T;
  swap(): void;
  reset(): void;
  destroy(): void;
  [Symbol.dispose](): void;
}

export interface TexturePingPong extends PingPongCore<Texture> {
  readonly size: TextureOptions["size"];
  resize(size: TextureOptions["size"]): boolean;
}

export interface BufferPingPong extends PingPongCore<Buffer> {
  readonly size: number;
  resize(byteLength: number): boolean;
}

export function pingPong(device: Device, opts: TextureOptions): TexturePingPong;
export function pingPong(device: Device, opts: BufferOptions): BufferPingPong;
export function pingPong(device: Device, opts: TextureOptions | BufferOptions): TexturePingPong | BufferPingPong {
  if (isBufferOptions(opts)) return createBufferPingPong(device, opts);
  return createTexturePingPong(device, opts);
}

function isBufferOptions(opts: TextureOptions | BufferOptions): opts is BufferOptions {
  return typeof opts.size === "number";
}

function createTexturePingPong(device: Device, opts: TextureOptions): TexturePingPong {
  let size = cloneTextureSize(opts.size);
  let readIsPing = true;
  let destroyed = false;
  let ping = device.createTexture(textureOptions(opts, size, "ping"));
  let pong = device.createTexture(textureOptions(opts, size, "pong"));

  return {
    get read() { return readIsPing ? ping : pong; },
    get write() { return readIsPing ? pong : ping; },
    get size() { return cloneTextureSize(size); },
    swap() { readIsPing = !readIsPing; },
    reset() { readIsPing = true; },
    resize(nextSize: TextureOptions["size"]): boolean {
      if (destroyed) throw new Error("PingPong is destroyed");
      if (sameTextureSize(size, nextSize)) return false;
      ping.destroy();
      pong.destroy();
      size = cloneTextureSize(nextSize);
      ping = device.createTexture(textureOptions(opts, size, "ping"));
      pong = device.createTexture(textureOptions(opts, size, "pong"));
      readIsPing = true;
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ping.destroy();
      pong.destroy();
    },
    [Symbol.dispose]() { this.destroy(); },
  };
}

function createBufferPingPong(device: Device, opts: BufferOptions): BufferPingPong {
  let size = opts.size;
  let readIsPing = true;
  let destroyed = false;
  let ping = device.createBuffer(bufferOptions(opts, size, "ping"));
  let pong = device.createBuffer(bufferOptions(opts, size, "pong"));

  return {
    get read() { return readIsPing ? ping : pong; },
    get write() { return readIsPing ? pong : ping; },
    get size() { return size; },
    swap() { readIsPing = !readIsPing; },
    reset() { readIsPing = true; },
    resize(nextSize: number): boolean {
      if (destroyed) throw new Error("PingPong is destroyed");
      if (size === nextSize) return false;
      ping.destroy();
      pong.destroy();
      size = nextSize;
      ping = device.createBuffer(bufferOptions(opts, size, "ping"));
      pong = device.createBuffer(bufferOptions(opts, size, "pong"));
      readIsPing = true;
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ping.destroy();
      pong.destroy();
    },
    [Symbol.dispose]() { this.destroy(); },
  };
}

function textureOptions(opts: TextureOptions, size: TextureOptions["size"], half: "ping" | "pong"): TextureOptions {
  return { ...opts, size: cloneTextureSize(size), label: label(opts.label, half) };
}

function bufferOptions(opts: BufferOptions, size: number, half: "ping" | "pong"): BufferOptions {
  return { ...opts, size, label: label(opts.label, half) };
}

function label(base: string | undefined, half: "ping" | "pong"): string | undefined {
  return base === undefined ? undefined : `${base}.${half}`;
}

function cloneTextureSize(size: TextureOptions["size"]): TextureOptions["size"] {
  return size[2] === undefined ? [size[0], size[1]] : [size[0], size[1], size[2]];
}

function sameTextureSize(a: TextureOptions["size"], b: TextureOptions["size"]): boolean {
  return a[0] === b[0] && a[1] === b[1] && (a[2] ?? 1) === (b[2] ?? 1);
}
