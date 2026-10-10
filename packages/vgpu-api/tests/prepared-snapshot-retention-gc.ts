import { prepareShader } from "@vgpu/wgsl/prepare";
import type { ComputePipeline } from "../src/compute.ts";
import { drawReflection, type InternalDraw } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { compute, draw, effect, frame, init, target } from "../src/mock.ts";

// Module-level artifacts live for the whole session, like `.wgsl` imports, so every consumer reuses one cached snapshot.
const DRAW = prepareShader(`
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(params.value); }
`);
const EFFECT = prepareShader(`
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main() -> @location(0) vec4f { return vec4f(params.value); }
`);
const COMPUTE = prepareShader(`
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(1) fn main() { values[0] += params.value; }
`);

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!gc) throw new Error("prepared snapshot retention probe requires process.execPath --expose-gc");

const gpu = await init();
try {
  const output = target(gpu, { size: [4, 4] });
  const values = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"] });
  const { shared, firstRefs } = makeFirst();
  const refs = [...firstRefs, ...makeAbandoned(32, false), ...makeAbandoned(32, true)];
  const control = effect(gpu, EFFECT, { label: "retained-control", set: { params: { value: 1 } } });
  const controlRef = new WeakRef(control);
  await gpu.settled();

  let collected = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    collected = refs.filter((reference) => reference.deref() === undefined).length;
    if (collected === refs.length) break;
  }
  if (collected !== refs.length) throw new Error(`GC probe inconclusive after bounded pressure: consumers ${collected}/${refs.length}`);
  if (controlRef.deref() !== control) throw new Error("deliberately retained control was collected");

  // The artifacts outlived every consumer and still serve new ones through the same snapshot.
  const later = makeConsumers(refs.length);
  const reused = drawReflection(later.draw as InternalDraw) === shared.draw
    && drawReflection(effectDraw(later.effect)) === shared.effect
    && (later.compute as ComputePipeline).reflection === shared.compute;
  const frozen = Object.isFrozen(shared.draw) && Object.isFrozen(shared.effect) && Object.isFrozen(shared.compute);
  later.compute.dispatch(1);
  frame(gpu, (currentFrame) => currentFrame.pass(output, (pass) => { pass.draw(later.draw); pass.draw(later.effect); pass.draw(control); }));
  await gpu.settled();
  later.draw.dispose();
  later.effect.dispose();
  later.compute.dispose();

  console.log(JSON.stringify({ collected, retained: true, reused, frozen }));

  function makeConsumers(index: number) {
    return {
      draw: draw(gpu, { shader: DRAW, label: `shared-draw-${index}`, set: { params: { value: index } } }),
      effect: effect(gpu, EFFECT, { label: `shared-effect-${index}`, set: { params: { value: index } } }),
      compute: compute(gpu, COMPUTE, { label: `shared-compute-${index}`, set: { params: { value: index }, values } }),
    };
  }

  // Keeps only the snapshot's reflection objects, which the artifact cache retains anyway, never the consumers.
  function makeFirst() {
    const first = makeConsumers(0);
    const shared = {
      draw: drawReflection(first.draw as InternalDraw),
      effect: drawReflection(effectDraw(first.effect)),
      compute: (first.compute as ComputePipeline).reflection,
    };
    const effectImpl = effectDraw(first.effect);
    first.draw.dispose();
    return { shared, firstRefs: [new WeakRef(first.draw), new WeakRef(first.effect), new WeakRef(effectImpl), new WeakRef(first.compute)] };
  }

  function makeAbandoned(count: number, dispose: boolean): WeakRef<object>[] {
    const created: WeakRef<object>[] = [];
    for (let index = 0; index < count; index += 1) {
      const consumers = makeConsumers(index + 1);
      consumers.compute.dispatch(1);
      frame(gpu, (currentFrame) => currentFrame.pass(output, (pass) => { pass.draw(consumers.draw); pass.draw(consumers.effect); }));
      const effectImpl = effectDraw(consumers.effect);
      if (dispose) {
        consumers.draw.dispose();
        consumers.effect.dispose();
        consumers.compute.dispose();
      }
      created.push(new WeakRef(consumers.draw), new WeakRef(consumers.effect), new WeakRef(effectImpl), new WeakRef(consumers.compute));
    }
    return created;
  }
} finally {
  gpu.dispose();
}
