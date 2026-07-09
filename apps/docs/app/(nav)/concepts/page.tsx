import { CodeBlock } from '@/components/CodeBlock';
import { Callout } from '@/components/mdx/Callout';

const deviceCode = `import { App } from "@vgpu/core";
import { createNodeAdapter } from "@vgpu/adapter-node";

const { device, queue } = await App.create({ adapter: createNodeAdapter() });

const buffer = device.createBuffer({
  size: 1024,
  usage: ["storage", "copy_dst", "copy_src"],
});

buffer.write(new Float32Array([1, 2, 3, 4]));
queue.gpu.submit([]);
device.destroy();`;

const materialCode = `import { material, fullscreenQuad } from "@vgpu/render";
import { pass } from "@vgpu/render/passes";

const mesh = fullscreenQuad({ device });
const mat = material({
  device,
  vertexLayout: "position-only",
  uniforms: { time: "f32", resolution: "vec2f" },
  vertex: VERTEX_WGSL,
  fragment: FRAGMENT_WGSL,
  depthFormat: null,
});

mat.writeUniforms({ time: 1.25, resolution: [1280, 720] });
pass({ mesh, material: mat, target });`;

const wgslCode = `struct Uniforms {
  time: f32,
  resolution: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / uniforms.resolution;
  return vec4f(uv, 0.5 + 0.5 * sin(uniforms.time), 1.0);
}`;

const adapterCode = `import { Device } from "@vgpu/core";

const adapter = await navigator.gpu.requestAdapter();
const gpuDevice = await adapter?.requestDevice();
if (!gpuDevice) throw new Error("WebGPU is unavailable");

const device = new Device(gpuDevice, adapter?.info ?? null);`;

const packageRows = [
  ['@vgpu/core', 'Device, Buffer, Texture, Shader, Queue, App, errors, and adapter contracts.'],
  ['@vgpu/render', 'Render pipelines, passes, frames, materials, meshes, render targets, and inspection helpers.'],
  ['@vgpu/wgsl', 'WGSL compile helpers, runtime shader resolution, and bundler loaders.'],
  ['@vgpu/wgsl-std', 'Reusable WGSL utility modules for shader authors.'],
  ['@vgpu/adapter-node', 'Dawn-backed WebGPU adapter for Node.js and serverless execution.'],
  ['@vgpu/adapter-mock', 'Deterministic adapter for unit tests without GPU hardware.'],
];

export default function ConceptsPage() {
  return (
    <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-4xl mx-auto">
      <h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">Core Concepts</h1>
      <p className="text-xl text-gray-10 mb-12">
        vgpu keeps the WebGPU mental model visible: adapters create devices, devices create resources, and render helpers compose pipelines into draws.
      </p>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Packages</h2>
        <p className="text-gray-11 mb-6">
          The monorepo publishes focused packages under the same namespace. Applications can depend on only the layers they use.
        </p>
        <div className="rounded-lg border border-gray-4 overflow-hidden">
          {packageRows.map(([name, description]) => (
            <div key={name} className="grid md:grid-cols-[11rem_1fr] gap-3 p-4 border-b border-gray-4 last:border-b-0 bg-gray-1">
              <code className="text-blue-9 text-sm">{name}</code>
              <p className="text-gray-10 text-sm leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="devices">Devices and Resources</h2>
        <p className="text-gray-11 mb-4">
          A <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">Device</code> wraps a native <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">GPUDevice</code> and exposes vgpu resource factories. Resources keep their underlying WebGPU handles available through <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">.gpu</code> for advanced interop.
        </p>
        <CodeBlock code={deviceCode} language="typescript" />
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="adapters">Adapters</h2>
        <p className="text-gray-11 mb-4">
          Adapters are the boundary between vgpu and the runtime. Node and test adapters implement the vgpu adapter contract; browsers can wrap native WebGPU directly.
        </p>
        <CodeBlock code={adapterCode} language="typescript" />
        <Callout type="info">
          Browser examples in this docs app use this direct wrapper so they run against the user&apos;s real WebGPU implementation.
        </Callout>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="materials">Materials, Meshes, and Passes</h2>
        <p className="text-gray-11 mb-4">
          The render layer offers small helpers for common drawing patterns. A mesh supplies vertices, a material owns shader state and bindings, and <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">pass()</code> records and submits a draw to a target.
        </p>
        <CodeBlock code={materialCode} language="typescript" />
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="wgsl">WGSL and Uniforms</h2>
        <p className="text-gray-11 mb-4">
          <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">material()</code> can inject a typed <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">uniforms</code> struct from a TypeScript schema, keeping shader declarations aligned with host writes.
        </p>
        <CodeBlock code={wgslCode} language="wgsl" />
      </section>
    </div>
  );
}
