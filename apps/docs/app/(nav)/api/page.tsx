import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

const packages = [
  { name: 'vgpu', href: '/packages/vgpu', description: 'Public ring-1 API: one Gpu context with pass, draw, compute, frame, bundle, target, ping-pong, and uniforms.', symbols: ['init', 'Gpu', 'Pass', 'Draw', 'Compute', 'Frame', 'Bundle', 'Target', 'SharedUniforms'] },
  { name: 'vgpu/core', href: '/packages/vgpu', description: 'Ring-0 escape hatches exported by the public package for native WebGPU control when ring-1 is not enough.', symbols: ['Device', 'Buffer', 'Texture', 'Uniform', 'UniformPool', 'StorageBuffer', 'bind'] },
  { name: 'vgpu/scene', href: '/packages/vgpu', description: 'Tree-shakeable geometry and camera helpers without a scene graph.', symbols: ['box', 'sphere', 'Mesh', 'perspectiveCamera', 'orthographicCamera'] },
  { name: '@vgpu/wgsl', href: '/packages/vgpu-wgsl', description: 'WGSL modules, compile helpers, runtime resolution, reflection, and bundler loaders.', symbols: ['compile', 'ResolvedShader', 'loader-webpack', 'loader-vite'] },
  { name: 'vgpu/node', href: '/getting-started', description: 'Headless entrypoint that initializes a Gpu without browser canvas globals.', symbols: ['init', 'target', 'read', 'dispose'] },
  { name: 'vgpu/mock', href: '/getting-started', description: 'Deterministic test entrypoint for snapshots and buffer assertions without GPU hardware.', symbols: ['init', 'storage', 'read', 'dispose'] },
];
const directInteropCode = `const draw = gpu.draw({ shader });
const layout = draw.layout(1, { dynamicOffsets: true });
draw.group(1, bindGroup);
gpu.frame((f) => f.pass({ target }, (p) => p.draw(draw, { offsets: { 1: [offset] } })));`;
export default function ApiPage() { return <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-5xl mx-auto"><header className="mb-12"><h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">API Overview</h1><p className="text-xl text-gray-10 max-w-3xl">The public package is <code>vgpu</code>. Start with ring-1 and drop to ring-0 only when you need native WebGPU control.</p></header><section className="grid md:grid-cols-2 gap-4 mb-12">{packages.map((pkg) => <Link key={pkg.name} href={pkg.href} className="group p-5 rounded-lg bg-gray-1 border border-gray-4 hover:border-gray-5 transition-all"><div className="flex items-center justify-between mb-3"><code className="text-blue-9 font-semibold">{pkg.name}</code><span className="text-gray-9 group-hover:text-blue-9">→</span></div><p className="text-sm text-gray-10 leading-relaxed mb-4">{pkg.description}</p><div className="flex flex-wrap gap-2">{pkg.symbols.map((symbol) => <span key={symbol} className="text-xs text-gray-10 bg-gray-2 border border-gray-4 px-2 py-1 rounded">{symbol}</span>)}</div></Link>)}</section><section className="mb-12"><h2 className="text-2xl font-semibold text-gray-12 mb-4">Native WebGPU Escape Hatches</h2><p className="text-gray-11 mb-4">Every ring-1 object exposes enough native state to interop with ring-0 and WebGPU. R4 group claim is the default path for manual bind groups.</p><CodeBlock code={directInteropCode} language="typescript" /></section></div>; }
