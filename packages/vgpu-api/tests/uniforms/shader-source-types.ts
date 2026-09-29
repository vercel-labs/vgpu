import type { ShaderSource } from "@vgpu/wgsl";
import * as browser from "../../src/index.ts";
import * as mock from "../../src/mock.ts";
import * as node from "../../src/node.ts";

declare const prepared: ShaderSource;
declare const browserGpu: Parameters<typeof browser.effect>[0];
declare const mockGpu: Parameters<typeof mock.effect>[0];
declare const nodeGpu: Parameters<typeof node.effect>[0];
const v1 = { version: 1 as const, wgsl: "" };

browser.effect(browserGpu, prepared);
browser.draw(browserGpu, { shader: prepared });
browser.compute(browserGpu, prepared);
mock.effect(mockGpu, prepared);
mock.draw(mockGpu, { shader: prepared });
mock.compute(mockGpu, prepared);
node.effect(nodeGpu, prepared);
node.draw(nodeGpu, { shader: prepared });
node.compute(nodeGpu, prepared);

// @ts-expect-error renderer effects require prepared ShaderSource v2 artifacts.
browser.effect(browserGpu, "@fragment fn main() {}");
// @ts-expect-error renderer draws require prepared ShaderSource v2 artifacts.
browser.draw(browserGpu, { shader: v1 });
// @ts-expect-error renderer compute requires prepared ShaderSource v2 artifacts.
browser.compute(browserGpu, v1);
// @ts-expect-error renderer effects require prepared ShaderSource v2 artifacts.
mock.effect(mockGpu, v1);
// @ts-expect-error renderer draws require prepared ShaderSource v2 artifacts.
mock.draw(mockGpu, { shader: "@vertex fn main() {}" });
// @ts-expect-error renderer compute requires prepared ShaderSource v2 artifacts.
mock.compute(mockGpu, "@compute @workgroup_size(1) fn main() {}");
// @ts-expect-error renderer effects require prepared ShaderSource v2 artifacts.
node.effect(nodeGpu, "@fragment fn main() {}");
// @ts-expect-error renderer draws require prepared ShaderSource v2 artifacts.
node.draw(nodeGpu, { shader: v1 });
// @ts-expect-error renderer compute requires prepared ShaderSource v2 artifacts.
node.compute(nodeGpu, v1);
