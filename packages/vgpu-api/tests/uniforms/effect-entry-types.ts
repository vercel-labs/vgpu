import { prepareShader } from "@vgpu/wgsl/prepare";
import { effect, type Gpu, type EffectOptions } from "../../src/index.ts";
import type { EffectOptions as NodeOptions } from "../../src/node.ts";
import type { EffectOptions as MockOptions } from "../../src/mock.ts";

declare const gpu: Gpu;
declare const source: string;
const options: EffectOptions = { entry: { fragment: "custom" } };
const node: NodeOptions = options;
const mock: MockOptions = options;
effect(gpu, prepareShader(source), options);
effect(gpu, prepareShader(source), { entry: {} });
// @ts-expect-error effects expose fragment selection only
effect(gpu, prepareShader(source), { entry: { vertex: "vs_main" } });
// @ts-expect-error fragment names must be strings
effect(gpu, prepareShader(source), { entry: { fragment: 1 } });
// @ts-expect-error effect entry uses the same object shape as draw
effect(gpu, prepareShader(source), { entry: "custom" });
void [node, mock];
