import { expect, test } from "vitest";
import { init } from "../src/mock.ts";

const vertexShader = (name: string) => `
@group(0) @binding(0) var<uniform> ${name}: vec4f;
@vertex fn vs() -> @builtin(position) vec4f { return ${name}; }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
`;
const fragmentShader = `
@group(0) @binding(0) var<uniform> value: vec4f;
@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
@fragment fn fs() -> @location(0) vec4f { return value; }
`;

test("equal visibility layouts reuse identity while distinct masks do not poison the cache", async () => {
  const gpu = await init();
  const a = gpu.draw({ shader: vertexShader("a"), label: "cache-a" });
  const b = gpu.draw({ shader: vertexShader("b"), label: "cache-b" });
  const fragment = gpu.draw({ shader: fragmentShader, label: "cache-fragment" });
  expect(a.layout(0)).toBe(b.layout(0));
  expect(fragment.layout(0)).not.toBe(a.layout(0));
  gpu.dispose();
});

test("unused bindings may be set and are ignored by the omitted layout", async () => {
  const gpu = await init();
  const shader = `
    @group(0) @binding(0) var<storage, read> unused: array<u32>;
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  const draw = gpu.draw({ shader, label: "unused-set" });
  expect(() => draw.set({ unused: gpu.storage(16, "read") })).not.toThrow();
  const target = gpu.target({ size: [1, 1] });
  expect(() => gpu.frame((frame) => frame.pass(target, (pass) => pass.draw(draw)))).not.toThrow();
  gpu.dispose();
});

test("bundle recording and mesh slices share narrowed pipeline layouts", async () => {
  const gpu = await init();
  const mesh = gpu.mesh({ buffers: [{ data: new Float32Array([0, 0, 1, 0, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }] });
  const first = gpu.draw({ shader: vertexShader("first"), label: "mesh-first", mesh });
  const second = gpu.draw({ shader: vertexShader("second"), label: "mesh-second", mesh: mesh.slice({ firstVertex: 0, vertexCount: 3 }) });
  first.set({ first: [0, 0, 0, 1] });
  second.set({ second: [0, 0, 0, 1] });
  expect(first.layout(0)).toBe(second.layout(0));
  const target = gpu.target({ size: [2, 2] });
  expect(() => gpu.bundle({ target, label: "narrowed-bundle" }, (bundle) => { bundle.draw(first); bundle.draw(second); })).not.toThrow();
  gpu.dispose();
});
