import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const binding = require(process.env.DAWN_NODE ?? '/cache/dawn.node');
Object.assign(globalThis, binding.globals);
const start = performance.now();
const flags = (process.env.DAWN_FLAGS ?? 'backend=vulkan').split(/\s+/).filter(Boolean);
const gpu = binding.create(flags);
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
assert(adapter, 'Dawn returned a null adapter');
const features = [...adapter.features].sort();
const limits = {
  maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
};
const info = {};
for (const key of ['vendor', 'architecture', 'device', 'description', 'backendType', 'adapterType']) {
  if (adapter.info?.[key] !== undefined) info[key] = adapter.info[key];
}
assert.equal(features.length, 17, `expected 17 Dawn features, got ${features.length}`);
assert(features.includes('shader-f16'), 'expected shader-f16 feature');
assert.equal(limits.maxComputeInvocationsPerWorkgroup, 1024);
const device = await adapter.requestDevice();
const uncaptured = [];
device.addEventListener?.('uncapturederror', event => uncaptured.push(String(event.error)));
const W = 64, H = 64, BPR = 256;
const texture = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const readback = device.createBuffer({ size: BPR * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const shader = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 var p=array<vec2f,3>(vec2f(-0.8,-0.8),vec2f(0.8,-0.8),vec2f(0.0,0.8)); return vec4f(p[i],0,1);
}
@fragment fn fs()->@location(0) vec4f { return vec4f(0.25,0.5,0.75,1.0); }
` });
const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
pass.setPipeline(pipeline); pass.draw(3); pass.end();
encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: BPR }, [W, H]);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const bytes = new Uint8Array(readback.getMappedRange());
const center = [...bytes.slice(32 * BPR + 32 * 4, 32 * BPR + 32 * 4 + 4)];
const corner = [...bytes.slice(0, 4)];
let nonblackPixels = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (bytes[y * BPR + x * 4] || bytes[y * BPR + x * 4 + 1] || bytes[y * BPR + x * 4 + 2]) nonblackPixels++;
}
assert.deepEqual(center, [64, 128, 191, 255]);
assert.deepEqual(corner, [0, 0, 0, 255]);
assert.equal(nonblackPixels, 1352);
assert.deepEqual(uncaptured, []);
const elapsedMs = Number((performance.now() - start).toFixed(3));
readback.unmap(); readback.destroy(); texture.destroy(); device.destroy();
console.log(JSON.stringify({ ok: true, flags, info, featureCount: features.length, features, limits, render: { width: W, height: H, center, corner, nonblackPixels, elapsedMs, uncaptured } }, null, 2));
