import { CodeBlock } from '@/components/code-block';
import { Callout } from '@/components/mdx/callout';
import { DocsPageShell } from '@/components/docs-page-shell';
const gpuCode = `import { init } from "vgpu";
const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const target = gpu.target({ size: [256, 256], format: "rgba16float", depth: true, msaa: true });`;
const setCode = `const wave = gpu.pass(\`
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, params.speed, 1); }
\`, { set: { speed: 2 } });
wave.set({ time: gpu.time });`;
const frameCode = `gpu.frame((f) => {
  f.pass({ target: scene }, (p) => p.draw(cube));
  f.pass({ target: surface }, (p) => p.draw(post));
});`;
const packageRows = [['vgpu', 'Public API: init, Gpu, pass, draw, compute, frame, bundle, target, uniforms.'], ['vgpu/core', 'Native WebGPU handles for buffers, textures, bind groups, and manual pipelines.'], ['vgpu/scene', 'Pure geometry and camera helpers.'], ['@vgpu/wgsl', 'WGSL module resolution, reflection, and loaders.']];
const toc = [{ id: 'packages', title: 'Packages', level: 2 as const }, { id: 'one-gpu-context', title: 'One Gpu context', level: 2 as const }, { id: 'wgsl-owns-bindings', title: 'WGSL owns bindings', level: 2 as const }, { id: 'frames-are-on-demand', title: 'Frames are on-demand', level: 2 as const }];
export default function ConceptsPage() { return <DocsPageShell pathname="/concepts" toc={toc}><h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">Core Concepts</h1><p className="text-xl text-gray-10 mb-12">vgpu is one context, explicit WGSL bindings, and frames you schedule yourself.</p><section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Packages</h2><div className="rounded-lg border border-gray-4 overflow-hidden">{packageRows.map(([name, description]) => <div key={name} className="grid md:grid-cols-[11rem_1fr] gap-3 p-4 border-b border-gray-4 last:border-b-0 bg-gray-1"><code className="text-blue-9 text-sm">{name}</code><p className="text-gray-10 text-sm leading-relaxed">{description}</p></div>)}</div></section><section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">One Gpu context</h2><CodeBlock code={gpuCode} language="typescript" /></section><section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">WGSL owns bindings</h2><p className="text-gray-11 mb-4">The shader declares resources; <code>set()</code> binds by name. JS values are written in-place, resources are user-owned.</p><CodeBlock code={setCode} language="typescript" /><Callout type="info">There are no globals. Pass time explicitly and read resolution from targets.</Callout></section><section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Frames are on-demand</h2><CodeBlock code={frameCode} language="typescript" /></section></DocsPageShell>; }
