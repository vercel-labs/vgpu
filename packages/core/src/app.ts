import type { AppCreateOptions, AppInstance } from "./app-types.ts";

export class App {
  static async create(opts: AppCreateOptions): Promise<AppInstance> {
    const device = await opts.adapter.requestDevice(opts);
    return { device, queue: device.queue };
  }
}
