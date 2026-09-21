import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { init, compute, effect, frame, storage, target, uniforms, bundle, pingPongStorage } from "../../src/node.ts";

const native = process.env.VGPU_DOCKER_TEST === "1" || process.env.VGPU_NATIVE_COMPUTE_TEST === "1";
describe.skipIf(!native)("native frame compute and uniform capture", () => {
  test("render → two compute dispatches → render preserves data and uniform ordering", async () => {
    const gpu = await init();
    try {
      const input = target(gpu, { size: [1, 1] });
      const output = target(gpu, { size: [1, 1] });
      const data = storage(gpu, 4);
      data.write(new Float32Array([0]));
      const fill = effect(gpu, "@fragment fn main() -> @location(0) vec4f { return vec4f(64.0/255.0, 0, 0, 1); }");
      const sim = compute(gpu, `
        @group(0) @binding(0) var input: texture_2d<f32>;
        @group(0) @binding(1) var<storage, read_write> data: array<f32>;
        @group(0) @binding(2) var<uniform> delta: f32;
        @compute @workgroup_size(1) fn main() { data[0] += round(textureLoad(input, vec2i(0), 0).r * 255.0) + delta; }
      `, { set: { input, data, delta: 1 } });
      const show = effect(gpu, `@group(0) @binding(0) var<storage, read> data: array<f32>;
        @fragment fn main() -> @location(0) vec4f { return vec4f(data[0] / 255.0, 0, 0, 1); }`, { set: { data } });
      await Promise.all([fill.compile(input), sim.compile(), show.compile(output)]);
      const f = frame(gpu, f => {
        f.pass(input, fill);
        f.computePass(p => { p.dispatch(sim, 1); sim.set({ delta: 2 }); p.dispatch(sim, 1); });
        f.pass(output, show);
      });
      await f.done;
      expect(new Float32Array(await data.read())[0]).toBe(131);
      expect((await output.color.read({ mipLevel: 0, region: "all" }))[0]).toBe(131);
    } finally { gpu.dispose(); }
  });

  test("shared uniforms capture per draw while bundles retain live values", async () => {
    const gpu = await init();
    try {
      const a = target(gpu, { size: [1, 1] });
      const b = target(gpu, { size: [1, 1] });
      const c = target(gpu, { size: [1, 1] });
      const params = uniforms(gpu, { value: 0.25 });
      const fx = effect(gpu, `struct Params { value:f32 } @group(0) @binding(0) var<uniform> params: Params;
        @fragment fn main() -> @location(0) vec4f { return vec4f(params.value, 0, 0, 1); }`, { set: { params } });
      await fx.compile(a);
      const recorded = bundle(gpu, { target: a }, p => p.draw(fx));
      const f = frame(gpu, f => {
        f.pass(a, fx);
        params.set({ value: 0.5 });
        f.pass(b, fx);
        params.set({ value: 0.75 });
        f.pass(c, p => p.bundles(recorded));
      });
      await f.done;
      const reds = await Promise.all([a, b, c].map(async t => (await t.color.read({ mipLevel: 0, region: "all" }))[0]));
      expect(reds).toEqual([64, 128, 191]);
    } finally { gpu.dispose(); }
  });

  test("GPU-produced indirect arguments and live shared storage survive dispatch boundaries", async () => {
    const gpu = await init();
    try {
      const args = storage(gpu, 12, { indirect: true });
      const state = uniforms(gpu, { count: 0 });
      const prepare = compute(gpu, `@group(0) @binding(0) var<storage,read_write> args:array<u32,3>;
        @compute @workgroup_size(1) fn main(){ args[0]=1; args[1]=1; args[2]=1; }`, { set: { args } });
      const out = storage(gpu, 4);
      const step = compute(gpu, `struct S { count:u32 } @group(0) @binding(0) var<storage,read_write> state:S;
        @group(0) @binding(1) var<storage,read_write> out:array<u32>;
        @compute @workgroup_size(1) fn main(){ state.count += 1; out[0]=state.count; }`, { set: { state, out } });
      await Promise.all([prepare.compile(), step.compile()]);
      const f = frame(gpu, f => f.computePass(p => {
        p.dispatch(prepare, 1); p.dispatch(step, { indirect: args }); p.dispatch(step, { indirect: args });
      }));
      await f.done;
      expect(new Uint32Array(await out.read())[0]).toBe(2);
      const canceled = frame(gpu);
      canceled.computePass(p => p.dispatch(step, 1));
      canceled.cancel();
      expect(new Uint32Array(await out.read())[0]).toBe(2);
    } finally { gpu.dispose(); }
  });

  test("ping-pong swaps capture resource identities for each encoded dispatch", async () => {
    const gpu = await init();
    try {
      const pair = pingPongStorage(gpu, 4);
      pair.read.write(new Float32Array([1]));
      const sim = compute(gpu, `
        @group(0) @binding(0) var<storage, read> src: array<f32>;
        @group(0) @binding(1) var<storage, read_write> dst: array<f32>;
        @group(0) @binding(2) var<uniform> delta: f32;
        @compute @workgroup_size(1) fn main() { dst[0] = src[0] + delta; }
      `);
      await sim.compile();
      const f = frame(gpu, f => f.computePass(p => {
        for (let delta = 1; delta <= 3; delta++) {
          sim.set({ src: pair.read, dst: pair.write, delta });
          p.dispatch(sim, 1);
          pair.swap();
        }
      }));
      await f.done;
      expect(new Float32Array(await pair.read.read())[0]).toBe(7);
    } finally { gpu.dispose(); }
  });

  test.each(["async", "sync"])("handled native pipeline validation leaves stdout parseable JSON (%s)", mode => {
    const entry = pathToFileURL(resolve("packages/vgpu-api/dist/node.js")).href;
    const code = `
      import { init, compute, storage } from ${JSON.stringify(entry)};
      const gpu = await init();
      const events=[]; gpu.onError(e => events.push(e.code));
      const data=storage(gpu,4); data.write(new Float32Array([1.5]));
      const kernel=compute(gpu, '@group(0) @binding(0) var<storage,read_write> data:array<f32>; override WG:u32=1; @compute @workgroup_size(WG) fn main(){ data[0]=42; }', { constants:{WG:gpu.device.limits.maxComputeWorkgroupSizeX+1}, set:{data} });
      let error; if (${JSON.stringify(mode)} === "async") { try { await kernel.compile(); } catch(e){ error=e.code; } } else { kernel.compileSync(); kernel.dispatch(1); }
      await gpu.settled();
      console.log(JSON.stringify({error,events,value:new Float32Array(await data.read())[0]}));
      gpu.dispose();
    `;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    expect(JSON.parse(stdout)).toEqual(mode === "async" ? { error: "VGPU-COMPILE-FAILED", events: [], value: 1.5 } : { events: ["VGPU-COMPILE-FAILED"], value: 1.5 });
  });
});
