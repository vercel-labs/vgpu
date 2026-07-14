import type { Gpu } from "../../src/index.ts";

declare const gpu: Gpu;

const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
globals.set({ time: 1 });
globals.set({ mouse: [1, 2] });
// @ts-expect-error unknown fields are rejected by values-first inference.
globals.set({ nope: 1 });
