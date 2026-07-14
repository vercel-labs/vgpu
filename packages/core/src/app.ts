import type { AppCreateOptions, AppInstance } from "./app-types.ts";

export class App {
  /**
   * @deprecated Use `init()` from `vgpu`, `vgpu/node`, or `vgpu/mock` for ring-1 applications. `App.create()` remains as a ring-0 escape hatch only.
   */
  static async create(opts: AppCreateOptions): Promise<AppInstance> {
    const device = await opts.adapter.requestDevice(opts);
    return { device, queue: device.queue };
  }
}
