import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

const heroCode = `import { Device } from "@vgpu/core";
import { material, fullscreenQuad } from "@vgpu/render";
import { pass, renderTargetForCanvas } from "@vgpu/render/passes";

const adapter = await navigator.gpu.requestAdapter();
const gpuDevice = await adapter?.requestDevice();
if (!gpuDevice) throw new Error("WebGPU is unavailable");

const device = new Device(gpuDevice, adapter?.info ?? null);
const mesh = fullscreenQuad({ device });
const mat = material({
  device,
  vertexLayout: "position-only",
  uniforms: { time: "f32", resolution: "vec2f" },
  vertex: VERTEX_WGSL,
  fragment: FRAGMENT_WGSL,
});

function frame(time: number) {
  mat.writeUniforms({ time: time / 1000, resolution: [canvas.width, canvas.height] });
  pass({ mesh, material: mat, target: renderTargetForCanvas(context) });
  requestAnimationFrame(frame);
}`;

const features = [
  ['Small primitives', 'Device, buffer, texture, shader, queue, and render layers that stay close to WebGPU.'],
  ['Real adapters', 'Run against browser WebGPU, Dawn-backed Node.js, or a deterministic mock adapter for tests.'],
  ['WGSL tooling', 'Compile helpers, runtime resolution, and webpack/vite loaders for shader files.'],
  ['Render helpers', 'Fullscreen quads, materials, render targets, passes, bundles, and inspection utilities.'],
  ['Agentic-first', 'A compact API surface designed to be understandable by humans and coding agents.'],
  ['Workspace native', 'Composable packages under @vgpu/* so applications can install only what they need.'],
];

export default function HomePage() {
  return (
    <div className="px-6 py-16 lg:px-12 lg:py-20">
      <section className="max-w-4xl mx-auto text-center mb-24">
        <div className="mb-8 flex flex-wrap justify-center gap-3">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-1 border border-blue-4 text-blue-9 text-sm font-medium">
            WebGPU primitives
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-2 border border-gray-4 text-gray-10 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-9" />
            Early preview 0.0.8
          </div>
        </div>

        <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-gray-12 mb-6 tracking-tight">
          vgpu
        </h1>

        <p className="text-lg md:text-xl text-gray-10 mb-10 max-w-2xl mx-auto leading-relaxed">
          Agentic-first WebGPU primitives for Node, browsers, and serverless runtimes.
          Build renderers, tools, tests, and examples with a small composable API.
        </p>

        <div className="flex flex-wrap justify-center gap-4 mb-16">
          <Link href="/getting-started" className="px-5 py-2.5 rounded-lg bg-gray-12 text-black font-medium text-sm hover:bg-gray-11 transition-colors">
            Get Started
          </Link>
          <Link href="/api" className="px-5 py-2.5 rounded-lg bg-gray-2 text-gray-12 font-medium text-sm border border-gray-4 hover:border-gray-5 hover:bg-gray-1 transition-colors">
            API Overview
          </Link>
        </div>

        <div className="text-left max-w-2xl mx-auto">
          <CodeBlock code={heroCode} language="typescript" />
        </div>
      </section>

      <section className="max-w-4xl mx-auto mb-24">
        <h2 className="text-2xl md:text-3xl font-semibold text-gray-12 text-center mb-4">
          Everything You Need
        </h2>
        <p className="text-gray-9 text-center mb-12 max-w-xl mx-auto">
          Use the core WebGPU handles directly when you need them, and reach for higher-level render helpers when you want speed.
        </p>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(([title, description]) => (
            <div key={title} className="p-5 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-colors group">
              <div className="w-9 h-9 rounded-md bg-gray-2 flex items-center justify-center text-gray-9 mb-4 group-hover:text-gray-12 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-gray-12 mb-2">{title}</h3>
              <p className="text-sm text-gray-9 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-4xl mx-auto">
        <h2 className="text-2xl md:text-3xl font-semibold text-gray-12 text-center mb-12">
          Explore the Docs
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            ['/getting-started', 'Getting Started', 'Install packages and render your first triangle.'],
            ['/concepts', 'Core Concepts', 'Learn devices, resources, materials, passes, and adapters.'],
            ['/api', 'API Overview', 'Package map and links into generated reference pages.'],
            ['/examples', 'Examples', 'Live WebGPU demos with read-only source views.'],
          ].map(([href, title, description]) => (
            <Link key={href} href={href} className="group p-6 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-all">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-gray-12 group-hover:text-blue-9 transition-colors">{title}</h3>
                <span className="text-gray-9 group-hover:text-blue-9 group-hover:translate-x-0.5 transition-all">→</span>
              </div>
              <p className="text-sm text-gray-9">{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
