import { CodeBlock } from '@/components/code-block';
import { Callout } from '@/components/mdx/callout';
import { DocsPageShell } from '@/components/docs-page-shell';

const gpuCode = `import { init } from "vgpu";
const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const target = gpu.target({ size: [256, 256], format: "rgba16float", depth: true, msaa: true });`;

const setCode = [
  'const waveSource = /* wgsl */ `',
  '  struct Params { time: f32, speed: f32 }',
  '  @group(0) @binding(0) var<uniform> params: Params;',
  '',
  '  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {',
  '    return vec4f(uv, params.speed, 1);',
  '  }',
  '`;',
  '',
  'const wave = gpu.effect(waveSource, {',
  '  set: { params: { time: 0, speed: 2 } }, // initial uniform defaults',
  '});',
  '',
  'wave.set({ params: { time: gpu.time } }); // update uniforms per frame',
].join('\n');

const oneShotCode = `wave.draw({ target: surface }); // one encoder, one submit — that's the whole frame`;

const frameCode = `const boat = gpu.effect(boatSource); // a second effect, created once like wave

gpu.frame((frame) => {
  frame.pass({ target: surface }, (pass) => {
    pass.draw(wave); // nothing new is compiled — pipelines were built at creation
    pass.draw(boat);
  });
}); // runs immediately, submits everything above once`;

const loopCode = `const handle = gpu.frame.loop((frame) => {
  wave.set({ params: { time: gpu.time } }); // update uniforms every tick
  frame.pass({ target: surface }, (pass) => pass.draw(wave));
}, { fps: 60 }); // optional throttle

handle.stop(); // stop when the canvas goes away`;

const packageRows = [
  ['vgpu', 'Public API: init, Gpu, effect, draw, compute, frame, bundle, target, uniforms.'],
  ['vgpu/core', 'Native WebGPU handles for buffers, textures, bind groups, and manual pipelines.'],
  ['vgpu/scene', 'Pure geometry and camera helpers.'],
  ['@vgpu/wgsl', 'WGSL module resolution, reflection, and loaders.'],
];

const toc = [
  { id: 'packages', title: 'Packages', level: 2 as const },
  { id: 'one-gpu-context', title: 'One Gpu context', level: 2 as const },
  { id: 'wgsl-owns-bindings', title: 'WGSL owns bindings', level: 2 as const },
  { id: 'render-a-frame', title: 'Render a frame', level: 2 as const },
  { id: 'animate-with-frame-loop', title: 'Animate with frame.loop()', level: 2 as const },
];

export default function ConceptsPage() {
  return (
    <DocsPageShell pathname="/concepts" toc={toc}>
      <h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">Core Concepts</h1>
      <p className="text-xl text-gray-10 mb-12">vgpu is one context, explicit WGSL bindings, and frames you schedule yourself.</p>

      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Packages</h2>
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
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">One Gpu context</h2>
        <CodeBlock code={gpuCode} language="typescript" />
      </section>

      <section className="mb-12" id="wgsl-owns-bindings">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">WGSL owns bindings</h2>
        <p className="text-gray-11 mb-4">
          WGSL declares every binding you plan to use (<code>var&lt;uniform&gt;</code>, textures, storage buffers, and so on). That shader source is the authority on layouts.
        </p>
        <p className="text-gray-11 mb-4">
          <code>set()</code> connects JavaScript data to a binding by the WGSL variable name, so calling <code>set(&#123; params: ... &#125;)</code> updates the <code>params</code> block you declared in WGSL.
          Plain JS values are copied into the uniform buffer, while GPU resources such as textures or buffers stay under your ownership—you decide when to reuse, resize, or dispose them.
        </p>
        <CodeBlock code={setCode} language="typescript" />
        <Callout type="info">There are no globals. Pass time explicitly and read resolution from targets.</Callout>
      </section>

      <section className="mb-12" id="render-a-frame">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Render a frame</h2>
        <p className="text-gray-11 mb-4">
          The simplest draw is a one-shot. <code>wave.draw()</code> encodes a single render pass and submits it immediately.
          Nothing keeps drawing afterward—when something changes (a resize, a drag, a toggle), call it again from your event handler.
        </p>
        <CodeBlock code={oneShotCode} language="typescript" />
        <p className="text-gray-11 mb-4">
          To draw more than one thing, batch the work with <code>gpu.frame()</code>. It runs your callback right away and submits everything inside as a single command buffer.
        </p>
        <CodeBlock code={frameCode} language="typescript" />
        <Callout type="info">One-shot draws submit per call; a frame submits once for everything inside. Ten draws in one frame is still one submit.</Callout>
      </section>

      <section className="mb-12" id="animate-with-frame-loop">
        <h2 className="text-2xl font-semibold text-gray-12 mb-4">Animate with frame.loop()</h2>
        <p className="text-gray-11 mb-4">
          For animation, start a loop instead. <code>gpu.frame.loop()</code> calls your callback once per tick and advances <code>gpu.time</code> for you.
          Update uniforms inside the callback, and stop the loop when you are done.
        </p>
        <CodeBlock code={loopCode} language="typescript" />
        <Callout type="info">Good to know: you never call <code>requestAnimationFrame</code> yourself—<code>gpu.frame.loop()</code> drives it internally.</Callout>
      </section>
    </DocsPageShell>
  );
}
