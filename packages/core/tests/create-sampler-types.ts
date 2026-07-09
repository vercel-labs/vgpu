import { createSampler } from "../src/bind.ts";

const device = {} as GPUDevice;

createSampler(device, { filter: "linear", wrap: "clamp" });
createSampler(device, { filter: "nearest", wrap: "repeat" });
createSampler(device, { wrap: "mirror" });

// @ts-expect-error filter accepts only the shorthand footprint filter values.
createSampler(device, { filter: "trilinear" });

// @ts-expect-error wrap accepts only the vgpu shorthand values, not raw WebGPU spellings.
createSampler(device, { wrap: "clamp-to-edge" });
