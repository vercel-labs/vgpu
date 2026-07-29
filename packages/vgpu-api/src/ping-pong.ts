import type { Device } from "@vgpu/core";
import type { PingPongStorage, PingPongTargets, StorageAccess, StorageBuffer } from "./api-types.ts";
import type { Gpu, Kernel } from "./kernel.ts";
import { liveKernel, ownResource } from "./live-kernel.ts";
import type { Target, TargetOptions, TargetTextureOptions } from "./target.ts";
import { OffscreenTarget } from "./target-offscreen.ts";
import { createStorageBuffer, type RingStorageBuffer } from "./storage.ts";

/**
 * Two offscreen targets read/write swapped by `swap()`: the classic feedback pair for blur chains,
 * fluid solvers and any effect that samples the previous result. Both halves are destroyed by
 * `gpu.dispose()`.
 */
export function pingPong(gpu: Gpu, width: number, height: number, opts: TargetTextureOptions = {}): PingPongTargets {
  const kernel = liveKernel(gpu, "pingPong");
  return createPingPongTargets(kernel.device, width, height, opts, (target) => ownTarget(kernel, target));
}

/** Two storage buffers of `bytes` read/write swapped by `swap()`. Both halves are destroyed by `gpu.dispose()`. */
export function pingPongStorage(gpu: Gpu, bytes: number): PingPongStorage {
  const kernel = liveKernel(gpu, "pingPongStorage");
  return createPingPongStorage(kernel.device, bytes, "read-write", (buffer) => ownBuffer(kernel, buffer));
}

function ownTarget(kernel: Kernel, target: OffscreenTarget): OffscreenTarget {
  return ownResource(kernel, target, (owned) => owned.destroy(), (cb) => { target.onDestroy(cb); });
}

function ownBuffer(kernel: Kernel, buffer: RingStorageBuffer): RingStorageBuffer {
  return ownResource(kernel, buffer, (owned) => owned.destroy(), (cb) => { buffer.onDestroy(cb); });
}

/** @internal `own` claims each half for a lifetime (the kernel's, from `pingPong()`); omitted, the halves are unowned. */
export function createPingPongTargets(device: Device, width: number, height: number, opts: TargetTextureOptions = {}, own: (target: OffscreenTarget) => OffscreenTarget = identity): PingPongTargets {
  const size: readonly [number, number] = [clampDimension(width), clampDimension(height)];
  const baseOptions: TargetOptions = { ...opts, size };
  const ping = own(new OffscreenTarget(device, labelOption(baseOptions, opts.label, "ping")));
  const pong = own(new OffscreenTarget(device, labelOption(baseOptions, opts.label, "pong")));
  return new TargetPingPong([ping, pong]);
}

/** @internal See {@link createPingPongTargets} for `own`. */
export function createPingPongStorage(device: Device, bytes: number, access: StorageAccess = "read-write", own: (buffer: RingStorageBuffer) => RingStorageBuffer = identity): PingPongStorage {
  const ping = own(createStorageBuffer(device, bytes, access, undefined));
  const pong = own(createStorageBuffer(device, bytes, access, undefined));
  return new StoragePingPong([ping, pong]);
}

function identity<T>(value: T): T { return value; }

class TargetPingPong implements PingPongTargets {
  #parity = 0;
  constructor(private readonly halves: readonly [Target, Target]) {}
  get read(): Target { return this.halves[this.#parity]; }
  get write(): Target { return this.halves[this.#parity ^ 1]; }
  swap(): void { this.#parity ^= 1; }
}

class StoragePingPong implements PingPongStorage {
  #parity = 0;
  constructor(private readonly halves: readonly [StorageBuffer, StorageBuffer]) {}
  get read(): StorageBuffer { return this.halves[this.#parity]; }
  get write(): StorageBuffer { return this.halves[this.#parity ^ 1]; }
  swap(): void { this.#parity ^= 1; }
}

function clampDimension(value: number): number {
  return Math.max(1, Math.floor(value));
}

function labelOption(opts: TargetOptions, label: string | undefined, suffix: string): TargetOptions {
  if (!label) return opts;
  return { ...opts, label: `${label}.${suffix}` };
}
