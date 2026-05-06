import type { AppCreateOptions, AppInstance } from "./types.ts";

export class App {
  static async create(opts: AppCreateOptions): Promise<AppInstance> {
    const device = await opts.adapter.requestDevice(opts);
    return { device, queue: device.queue };
  }
}
