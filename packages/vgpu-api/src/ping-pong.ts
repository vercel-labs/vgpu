import type { Device } from "@vgpu/core";
import type { PingPongStorage, PingPongTargets, StorageAccess, StorageBuffer } from "./gpu.ts";
import type { Target, TargetOptions } from "./target.ts";
import { OffscreenTarget } from "./target-offscreen.ts";
import { createStorageBuffer } from "./storage.ts";

export function createPingPongTargets(device: Device, width: number, height: number, opts: TargetOptions = {}): PingPongTargets {
  const size: readonly [number, number] = [clampDimension(width), clampDimension(height)];
  const baseOptions: TargetOptions = { ...opts, size };
  const ping = new OffscreenTarget(device, labelOption(baseOptions, opts.label, "ping"));
  const pong = new OffscreenTarget(device, labelOption(baseOptions, opts.label, "pong"));
  return new TargetPingPong([ping, pong]);
}

export function createPingPongStorage(device: Device, bytes: number, access: StorageAccess = "read-write"): PingPongStorage {
  const ping = createStorageBuffer(device, bytes, access, undefined);
  const pong = createStorageBuffer(device, bytes, access, undefined);
  return new StoragePingPong([ping, pong]);
}

class TargetPingPong implements PingPongTargets {
  private parity = 0;
  constructor(private readonly halves: readonly [Target, Target]) {}
  get read(): Target { return this.halves[this.parity]; }
  get write(): Target { return this.halves[this.parity ^ 1]; }
  swap(): void { this.parity ^= 1; }
}

class StoragePingPong implements PingPongStorage {
  private parity = 0;
  constructor(private readonly halves: readonly [StorageBuffer, StorageBuffer]) {}
  get read(): StorageBuffer { return this.halves[this.parity]; }
  get write(): StorageBuffer { return this.halves[this.parity ^ 1]; }
  swap(): void { this.parity ^= 1; }
}

function clampDimension(value: number): number {
  return Math.max(1, Math.floor(value));
}

function labelOption(opts: TargetOptions, label: string | undefined, suffix: string): TargetOptions {
  if (!label) return opts;
  return { ...opts, label: `${label}.${suffix}` };
}
