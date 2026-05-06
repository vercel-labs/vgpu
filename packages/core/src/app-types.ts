import type { Device } from "./device.ts";
import type { CreateDeviceOptions } from "./types.ts";

export interface AppCreateOptions extends CreateDeviceOptions {
  readonly adapter: VGPUAdapter;
}

export interface AppInstance {
  readonly device: Device;
  readonly queue: Device["queue"];
}

export interface VGPUAdapter {
  requestDevice(opts?: CreateDeviceOptions): Promise<Device>;
}
