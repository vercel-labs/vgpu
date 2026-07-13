export { createGpu, type AdapterFactory, type Gpu, type InitOptions } from "./gpu.ts";

import { createGpu, type AdapterFactory, type InitOptions } from "./gpu.ts";

export function initWithAdapter(entry: "browser" | "node" | "mock", adapterFactory?: AdapterFactory, options?: InitOptions) {
  return createGpu(entry, options, {}, adapterFactory);
}
