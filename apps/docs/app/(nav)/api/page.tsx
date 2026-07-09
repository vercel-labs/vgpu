import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

const packages = [
  {
    name: '@vgpu/core',
    href: '/packages/vgpu-core',
    description: 'Runtime primitives for devices, buffers, textures, shaders, queues, app creation, errors, and adapter contracts.',
    symbols: ['App', 'Device', 'Buffer', 'Texture', 'Shader', 'Queue'],
  },
  {
    name: '@vgpu/render',
    href: '/packages/vgpu-render',
    description: 'Render pipelines, render passes, frames, bundles, materials, meshes, render targets, storage buffers, and inspection helpers.',
    symbols: ['RenderPass', 'createRenderPipeline', 'material', 'fullscreenQuad', 'pass'],
  },
  {
    name: '@vgpu/wgsl',
    href: '/packages/vgpu-wgsl',
    description: 'WGSL compilation, resolved shader metadata, runtime resolution, and webpack/vite loader entry points.',
    symbols: ['compile', 'ResolvedShader', 'loader-webpack', 'loader-vite'],
  },
  {
    name: '@vgpu/wgsl-std',
    href: '/packages/vgpu-wgsl-std',
    description: 'Standard WGSL modules and utility snippets for shader authors.',
    symbols: ['math', 'color', 'sampling'],
  },
  {
    name: '@vgpu/adapter-node',
    href: '/packages/vgpu-adapter-node',
    description: 'Dawn-backed adapter and direct device helpers for Node.js and serverless runtimes.',
    symbols: ['createNodeAdapter', 'createNodeDevice'],
  },
  {
    name: '@vgpu/adapter-mock',
    href: '/packages/vgpu-adapter-mock',
    description: 'Mock WebGPU adapter for deterministic tests and local validation without GPU hardware.',
    symbols: ['createMockAdapter'],
  },
];

const directInteropCode = `const buffer = device.createBuffer({
  size: 4096,
  usage: ["storage", "copy_dst", "copy_src"],
});

const bindGroup = device.gpu.createBindGroup({
  layout,
  entries: [{ binding: 0, resource: { buffer: buffer.gpu } }],
});

device.queue.gpu.submit([commandEncoder.finish()]);`;

export default function ApiPage() {
  return (
    <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-5xl mx-auto">
      <header className="mb-12">
        <h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">API Overview</h1>
        <p className="text-xl text-gray-10 max-w-3xl">
          vgpu is organized as focused packages. This overview maps the surface area; generated per-symbol pages are linked from the package navigation.
        </p>
      </header>

      <section className="grid md:grid-cols-2 gap-4 mb-12">
        {packages.map((pkg) => (
          <Link
            key={pkg.name}
            href={pkg.href}
            className="group p-5 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <code className="text-blue-9 font-semibold">{pkg.name}</code>
              <span className="text-gray-9 group-hover:text-blue-9 group-hover:translate-x-0.5 transition-all">→</span>
            </div>
            <p className="text-sm text-gray-10 leading-relaxed mb-4">{pkg.description}</p>
            <div className="flex flex-wrap gap-2">
              {pkg.symbols.map((symbol) => (
                <span key={symbol} className="text-xs text-gray-10 bg-gray-2 border border-gray-4 px-2 py-1 rounded">
                  {symbol}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Native WebGPU Escape Hatches</h2>
        <p className="text-gray-11 mb-4">
          vgpu wraps common resource lifecycles but keeps native handles available. Use <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">.gpu</code> when you need a WebGPU API that the helper layer does not wrap yet.
        </p>
        <CodeBlock code={directInteropCode} language="typescript" />
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-gray-12 mb-6">Guides</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {[
            ['Getting Started', '/getting-started', 'Install packages and create your first device.'],
            ['Core Concepts', '/concepts', 'Understand resources, adapters, materials, and WGSL.'],
            ['Examples', '/examples', 'Browse live browser examples and source files.'],
            ['Repository', 'https://github.com/vercel-labs/vgpu', 'Read package READMEs and source on GitHub.'],
          ].map(([title, href, description]) => (
            <Link key={href} href={href} className="p-4 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-colors group">
              <h3 className="font-semibold text-gray-12 mb-2 group-hover:text-blue-9 transition-colors">{title} →</h3>
              <p className="text-gray-9 text-sm">{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
