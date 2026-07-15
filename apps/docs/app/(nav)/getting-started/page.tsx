import { CodeBlock } from '@/components/code-block';
import { Callout } from '@/components/mdx/callout';

const installCode = `pnpm add vgpu
pnpm add -D @webgpu/types`;
const nodeTriangleCode = `import { init } from "vgpu/node";

const gpu = await init({ size: [512, 512] });
const target = gpu.target({ format: "rgba8unorm" });
const triangle = gpu.draw({ shader: \`
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(0, .6), vec2f(-.6, -.6), vec2f(.6, -.6));
  return vec4f(p[vi], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(.2, .6, 1, 1); }
\` });

gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(triangle)));
const pixels = await target.read();
gpu.dispose();`;
const browserCode = `import { init } from "vgpu";

const gpu = await init(canvas, { dpr: [1, 2] });
const wave = gpu.pass(\`
struct Params { time: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, .5 + .5 * sin(params.time), 1);
}
\`);

gpu.frame.loop(() => {
  wave.set({ time: gpu.time });
  wave.draw();
});`;
const testCode = `import { init } from "vgpu/mock";

const gpu = await init({ size: [64, 64] });
const buffer = gpu.storage(16);
buffer.write(new Float32Array([1, 2, 3, 4]));
await expect(buffer.read()).resolves.toBeInstanceOf(ArrayBuffer);
gpu.dispose();`;

export default function GettingStartedPage() {
  return <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-4xl mx-auto">
    <h1 className="text-3xl md:text-4xl font-bold text-gray-12 mb-4">Getting Started</h1>
    <p className="text-xl text-gray-10 mb-12">Install the `vgpu` package and write WGSL as the source of truth for bindings.</p>
    <section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Installation</h2><CodeBlock code={installCode} language="bash" /><Callout type="info">Browser, Node, and mock entrypoints all return the same <code>Gpu</code> API.</Callout></section>
    <section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Node.js Rendering</h2><CodeBlock code={nodeTriangleCode} language="typescript" showLineNumbers /></section>
    <section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Browser Rendering</h2><CodeBlock code={browserCode} language="typescript" showLineNumbers /></section>
    <section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Testing</h2><CodeBlock code={testCode} language="typescript" /></section>
  </div>;
}
