import { compute, frame, type Gpu, type Compute, type FrameComputePass, type FrameComputePassOptions } from "../../src/index.ts";
import type { FrameComputePass as NodePass } from "../../src/node.ts";
import type { FrameComputePass as MockPass } from "../../src/mock.ts";
declare const gpu: Gpu;
declare const pipeline: Compute;
declare const pass: FrameComputePass;
const compiled: Promise<Compute> = pipeline.compile();
const sync: Compute = pipeline.compileSync();
const options: FrameComputePassOptions = { label: "step" };
const node: NodePass = pass;
const mock: MockPass = pass;
frame(gpu, f => f.computePass(options, p => {
  p.dispatch(pipeline, 1);
  p.dispatch(pipeline, 1, 2, 3);
  // @ts-expect-error compute passes only accept compute pipelines
  p.dispatch({}, 1);
  // @ts-expect-error compute pipelines have no target parameter
  pipeline.compile({});
}));
const created: Compute = compute(gpu, "@compute @workgroup_size(1) fn main() {}");
void [compiled, sync, node, mock, created];
