import Link from 'next/link';
import { CodeBlock } from '@/components/code-block';

const heroCode = `import { init } from "vgpu";

const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const wave = gpu.pass(WAVE_WGSL, { set: { speed: 2 } });

gpu.frame.loop(() => {
  wave.set({ time: gpu.time });
  wave.draw();
});`;

const features = [
  ['One context', 'Use `init()` to get a Gpu with pass, draw, compute, frame, bundle, target, and uniforms.'],
  ['Explicit WGSL', 'Shaders declare bindings; vgpu reflects them and `set()` binds by name.'],
  ['Perf by default', 'Bundles, pre-warmed pipelines, dynamic offsets, shared uniforms, and bake patterns are documented as defaults.'],
  ['Browser and Node', 'Use the same Gpu API from `vgpu`, `vgpu/node`, and `vgpu/mock`.'],
  ['Native escape hatches', 'Drop to `vgpu/core` for native handles, buffers, textures, and bind groups when you need them.'],
  ['Scene helpers', 'Pure geometry and camera utilities live in `vgpu/scene` without a retained scene graph.'],
];

export default function HomePage() {
  return (
    <div className="px-6 py-16 lg:px-12 lg:py-20">
      <section className="max-w-4xl mx-auto text-center mb-24">
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-gray-12 mb-6 tracking-tight">vgpu</h1>
        <p className="text-lg md:text-xl text-gray-10 mb-10 max-w-2xl mx-auto leading-relaxed">Agentic-first WebGPU for shaders that should be correct and fast the first time.</p>
        <div className="flex flex-wrap justify-center gap-4 mb-16">
          <Link href="/getting-started" className="px-5 py-2.5 rounded-lg bg-gray-12 text-black font-medium text-sm hover:bg-gray-11 transition-colors">Get Started</Link>
          <Link href="/reference" className="px-5 py-2.5 rounded-lg bg-gray-2 text-gray-12 font-medium text-sm border border-gray-4 hover:border-gray-5 hover:bg-gray-1 transition-colors">API Reference</Link>
        </div>
        <div className="text-left max-w-2xl mx-auto"><CodeBlock code={heroCode} language="typescript" /></div>
      </section>
      <section className="max-w-4xl mx-auto mb-24">
        <h2 className="text-2xl md:text-3xl font-semibold text-gray-12 text-center mb-4">Everything You Need</h2>
        <p className="text-gray-9 text-center mb-12 max-w-xl mx-auto">Start with the public `vgpu` API. Drop to native WebGPU only when you need explicit control.</p>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(([title, description]) => (
            <div key={title} className="p-5 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-colors group">
              <h3 className="text-sm font-semibold text-gray-12 mb-2">{title}</h3>
              <p className="text-sm text-gray-9 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="max-w-4xl mx-auto">
        <h2 className="text-2xl md:text-3xl font-semibold text-gray-12 text-center mb-12">Explore the Docs</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            ['/getting-started', 'Getting Started', 'Install `vgpu` and render with `init()`.'],
            ['/concepts', 'Core Concepts', 'Learn Gpu, set(), targets, frames, bundles, and adapters.'],
            ['/reference', 'API Reference', 'Package map and generated topic pages.'],
            ['/examples', 'Examples', 'Live WebGPU demos with read-only source views.'],
          ].map(([href, title, description]) => (
            <Link key={href} href={href} className="group p-6 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-all">
              <div className="flex items-center justify-between mb-2"><h3 className="font-semibold text-gray-12 group-hover:text-blue-9 transition-colors">{title} →</h3></div>
              <p className="text-sm text-gray-9">{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
