import { CodeBlock } from '@/components/CodeBlock';
import { Callout } from '@/components/mdx/Callout';

const installCode = `pnpm add @vgpu/core @vgpu/render @vgpu/wgsl

# Node.js / serverless adapter
pnpm add @vgpu/adapter-node

# Deterministic tests without GPU hardware
pnpm add -D @vgpu/adapter-mock @webgpu/types`;

const nodeTriangleCode = `import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { createRenderPipeline, RenderPass } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";

const shader = compile(\`
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(0.0, 0.6), vec2f(-0.6, -0.6), vec2f(0.6, -0.6));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(0.2, 0.6, 1.0, 1.0);
}
\`);

const { device } = await App.create({ adapter: createNodeAdapter() });
const target = device.createTexture({
  size: [512, 512],
  format: "rgba8unorm",
  usage: ["render_attachment", "copy_src"],
});
const module = device.createShader(shader);
const pipeline = createRenderPipeline(device, {
  shader: module,
  vertex: { entry: "vs_main" },
  fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});

const renderPass = new RenderPass(device, {
  colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
});
renderPass.setPipeline(pipeline);
renderPass.draw(3);
renderPass.end();

const pixels = await target.read();
device.destroy();`;

const browserCode = `import { Device } from "@vgpu/core";
import { fullscreenQuad, material } from "@vgpu/render";
import { pass, renderTargetForCanvas } from "@vgpu/render/passes";

const VERTEX = \`
struct VIn { @location(0) position: vec3f };
@vertex fn vs_main(input: VIn) -> @builtin(position) vec4f {
  return vec4f(input.position, 1.0);
}
\`;

const FRAGMENT = \`
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / uniforms.resolution;
  return vec4f(uv, 0.5 + 0.5 * sin(uniforms.time), 1.0);
}
\`;

const adapter = await navigator.gpu.requestAdapter();
const gpuDevice = await adapter?.requestDevice();
if (!gpuDevice) throw new Error("WebGPU is unavailable");

const device = new Device(gpuDevice, adapter?.info ?? null);
const context = canvas.getContext("webgpu");
if (!context) throw new Error("Canvas does not support WebGPU");

context.configure({
  device: device.gpu,
  format: navigator.gpu.getPreferredCanvasFormat(),
  alphaMode: "opaque",
});

const mesh = fullscreenQuad({ device });
const mat = material({
  device,
  vertexLayout: "position-only",
  uniforms: { time: "f32", resolution: "vec2f" },
  vertex: VERTEX,
  fragment: FRAGMENT,
  targetFormat: navigator.gpu.getPreferredCanvasFormat(),
  depthFormat: null,
});
const target = renderTargetForCanvas(context);
const startedAt = performance.now();

function frame(now: number) {
  mat.writeUniforms({ time: (now - startedAt) / 1000, resolution: [canvas.width, canvas.height] });
  pass({ mesh, material: mat, target });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);`;

const testCode = `import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";

const { device } = await App.create({ adapter: createMockAdapter() });
const buffer = device.createBuffer({
  size: 16,
  usage: ["copy_dst", "copy_src"],
});

buffer.write(new Float32Array([1, 2, 3, 4]));
await expect(buffer.read()).resolves.toEqual(new Float32Array([1, 2, 3, 4]));
device.destroy();`;

export default function GettingStartedPage() {
  return (
    <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-4xl mx-auto">
      <h1 className="text-3xl md:text-4xl font-bold text-gray-12 mb-4">Getting Started</h1>
      <p className="text-xl text-gray-10 mb-12">
        Install vgpu packages, choose an adapter, and render with a thin layer over WebGPU.
      </p>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="installation">Installation</h2>
        <p className="text-gray-11 mb-4">
          vgpu is split into small packages. Install the runtime pieces your application needs.
        </p>
        <CodeBlock code={installCode} language="bash" />
        <Callout type="info">
          The browser uses native <code>navigator.gpu</code>, so a separate browser adapter package is not required.
        </Callout>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="node-rendering">Node.js Rendering</h2>
        <p className="text-gray-11 mb-4">
          Use <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">@vgpu/adapter-node</code> for Dawn-backed rendering in scripts, tests, and serverless environments.
        </p>
        <CodeBlock code={nodeTriangleCode} language="typescript" showLineNumbers />
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="browser-rendering">Browser Rendering</h2>
        <p className="text-gray-11 mb-4">
          In a browser, wrap the native <code className="bg-gray-2 px-1.5 py-0.5 rounded text-sm">GPUDevice</code> and render to a canvas target.
        </p>
        <CodeBlock code={browserCode} language="typescript" showLineNumbers />
      </section>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4" id="testing">Testing</h2>
        <p className="text-gray-11 mb-4">
          The mock adapter lets unit tests validate resource lifecycles and command wiring without GPU hardware.
        </p>
        <CodeBlock code={testCode} language="typescript" />
      </section>
    </div>
  );
}
