const nativeCode = `const bindGroupLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
  ],
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(width, height);
pass.end();`;

const vgpuCode = `const layout = bind.group({
  particles: storageBuffer({ readWrite: true }),
  params: uniformBuffer<SimParams>(),
});

await frame(device)
  .compute(pipeline, layout.bind({ particles, params }))
  .dispatch({ x: width, y: height })
  .snapshot("particles-step.png");`;

const pillars = [
  {
    title: "Binding and layout helpers",
    body: "Name bind groups by intent, keep descriptors typed, and let repetitive boilerplate collapse into readable setup code.",
  },
  {
    title: "Frame and bundle helpers",
    body: "Compose command encoders, render passes, compute passes, bundles, and submission boundaries as product-level primitives.",
  },
  {
    title: "Texture descriptors",
    body: "Create color, depth, storage, and sampled textures with consistent labels, formats, usage flags, and resize behavior.",
  },
  {
    title: "Device limits and features",
    body: "Centralize adapter negotiation and make required limits explicit before GPU work reaches production paths.",
  },
  {
    title: "Headless snapshots",
    body: "Render deterministic PNG artifacts through node adapters so CI, docs, and agents can inspect visual output.",
  },
  {
    title: "WGSL std utilities",
    body: "Documented shader utility patterns keep WGSL modules small, reusable, and friendly to typed loader workflows.",
  },
] as const;

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

export function Header() {
  return (
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-tab-5 py-tab-4 text-[12px] text-muted-foreground md:px-tab-8">
      <a href="#top" className="flex items-center gap-tab-2 text-foreground" aria-label="VGPU home">
        <span className="grid size-block-0.5 place-items-center rounded-tab-2 border border-border bg-foreground text-[12px] font-semibold text-[#050505]">
          V
        </span>
        <span className="font-medium tracking-tight">VGPU</span>
      </a>
      <nav className="hidden items-center gap-tab-6 md:flex" aria-label="Primary navigation">
        <a className="transition hover:text-foreground" href="#comparison">Compare</a>
        <a className="transition hover:text-foreground" href="#features">Features</a>
        <a className="transition hover:text-foreground" href="#workflow">Agents</a>
        <a className="transition hover:text-foreground" href="#docs">Docs</a>
      </nav>
      <a
        className="rounded-tab-2 border border-border px-tab-3 py-tab-1.5 text-[12px] text-foreground transition hover:border-foreground"
        href="https://github.com/vercel-labs/vgpu"
      >
        GitHub
      </a>
    </header>
  );
}

export function HeroSection() {
  return (
    <section id="top" className="relative overflow-hidden border-b border-border">
      <div className="code-grid absolute inset-0 opacity-60" aria-hidden="true" />
      <div className="absolute left-1/2 top-0 h-px w-[80vw] -translate-x-1/2 bg-gradient-to-r from-transparent via-foreground to-transparent opacity-60" aria-hidden="true" />
      <div className="relative mx-auto flex min-h-[760px] w-full max-w-7xl flex-col items-center justify-center px-tab-5 py-block-2 text-center md:px-tab-8">
        <p className="mb-tab-4 rounded-full border border-border bg-background/70 px-tab-3 py-tab-1.5 text-[12px] text-muted-foreground backdrop-blur">
          WebGPU primitives for product teams and coding agents
        </p>
        <h1 className="max-w-5xl text-balance text-[48px] font-semibold leading-[0.95] tracking-[-0.06em] text-foreground md:text-[84px] lg:text-[112px]">
          Ship GPU interfaces without hiding the metal.
        </h1>
        <p className="mt-tab-6 max-w-2xl text-balance text-[18px] leading-8 text-muted-foreground md:text-[20px]">
          VGPU turns verbose WebGPU setup into typed, inspectable building blocks for layouts, frames, textures, device capabilities, WGSL modules, and headless visual snapshots.
        </p>
        <div className="mt-tab-8 flex flex-col gap-tab-3 sm:flex-row">
          <a className="inline-flex h-block-1.5 items-center justify-center gap-tab-2 rounded-tab-2 bg-foreground px-tab-5 text-[12px] font-medium text-[#050505] transition hover:bg-muted-foreground" href="#docs">
            Get started <Arrow />
          </a>
          <a className="inline-flex h-block-1.5 items-center justify-center gap-tab-2 rounded-tab-2 border border-border bg-background/70 px-tab-5 text-[12px] font-medium text-foreground backdrop-blur transition hover:border-foreground" href="#comparison">
            Compare APIs
          </a>
        </div>
      </div>
    </section>
  );
}

function CodePanel({ title, eyebrow, code }: { readonly title: string; readonly eyebrow: string; readonly code: string }) {
  return (
    <article className="overflow-hidden rounded-site border border-border bg-muted/70 shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-border px-tab-4 py-tab-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">{eyebrow}</p>
          <h3 className="mt-tab-1 text-[15px] font-medium text-foreground">{title}</h3>
        </div>
        <div className="flex gap-tab-1.5" aria-hidden="true">
          <span className="size-tab-2 rounded-full bg-[#3f3f46]" />
          <span className="size-tab-2 rounded-full bg-[#71717a]" />
          <span className="size-tab-2 rounded-full bg-[#f4f4f5]" />
        </div>
      </div>
      <pre className="min-h-[360px] overflow-x-auto p-tab-4 text-left font-mono text-[13px] leading-6 text-[#e4e4e7]"><code>{code}</code></pre>
    </article>
  );
}

export function ComparisonSection() {
  return (
    <section id="comparison" className="border-b border-border px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-tab-8 max-w-3xl">
          <p className="text-[12px] uppercase tracking-[0.24em] text-muted-foreground">Native WebGPU vs VGPU</p>
          <h2 className="mt-tab-3 text-[36px] font-semibold leading-tight tracking-[-0.04em] md:text-[56px]">Less ceremony, same escape hatch.</h2>
          <p className="mt-tab-4 text-[17px] leading-8 text-muted-foreground">VGPU keeps descriptors and command flow visible, then gives teams compact helpers around the parts they repeat every frame.</p>
        </div>
        <div className="grid gap-tab-4 lg:grid-cols-2">
          <CodePanel eyebrow="Native" title="Manual descriptors and pass wiring" code={nativeCode} />
          <CodePanel eyebrow="VGPU" title="Typed helpers around the same GPU objects" code={vgpuCode} />
        </div>
      </div>
    </section>
  );
}

export function FeaturePillarsSection() {
  return (
    <section id="features" className="border-b border-border px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col justify-between gap-tab-6 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <p className="text-[12px] uppercase tracking-[0.24em] text-muted-foreground">Feature pillars</p>
            <h2 className="mt-tab-3 text-[36px] font-semibold leading-tight tracking-[-0.04em] md:text-[56px]">Small primitives that cover the GPU loop.</h2>
          </div>
          <p className="max-w-md text-[16px] leading-7 text-muted-foreground">Each primitive is designed for inspection first: readable labels, explicit resources, and native WebGPU access when the abstraction stops helping.</p>
        </div>
        <div className="mt-tab-8 grid gap-tab-3 md:grid-cols-2 lg:grid-cols-3">
          {pillars.map((pillar, index) => (
            <article key={pillar.title} className="min-h-block-5 rounded-site border border-border bg-muted/45 p-tab-5 transition hover:border-[#52525b]">
              <p className="font-mono text-[12px] text-muted-foreground">0{index + 1}</p>
              <h3 className="mt-tab-8 text-[20px] font-semibold tracking-[-0.02em]">{pillar.title}</h3>
              <p className="mt-tab-3 text-[15px] leading-7 text-muted-foreground">{pillar.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function WorkflowSection() {
  return (
    <section id="workflow" className="border-b border-border px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto grid max-w-7xl gap-tab-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <p className="text-[12px] uppercase tracking-[0.24em] text-muted-foreground">Agentic and headless</p>
          <h2 className="mt-tab-3 text-[36px] font-semibold leading-tight tracking-[-0.04em] md:text-[56px]">Make GPU output reviewable by people and agents.</h2>
          <p className="mt-tab-4 text-[17px] leading-8 text-muted-foreground">Deterministic screenshots and PNG snapshots become build artifacts, not one-off local checks. Agents can change shaders, run a visual command, and attach images to review.</p>
        </div>
        <div className="rounded-site border border-border bg-background p-tab-3">
          <div className="rounded-tab-3 border border-border bg-muted p-tab-5">
            <div className="flex items-center justify-between border-b border-border pb-tab-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Pipeline</p>
                <h3 className="mt-tab-1 text-[18px] font-medium">Headless visual loop</h3>
              </div>
              <span className="rounded-full border border-border px-tab-2 py-tab-1 text-[10px] text-muted-foreground">CI ready</span>
            </div>
            <ol className="mt-tab-5 space-y-tab-3">
              {["Negotiate adapter and limits", "Render static fallback or node GPU snapshot", "Write desktop/mobile PNG artifacts", "Review contrast, spacing, overflow, and copy", "Keep native WebGPU path available"].map((step) => (
                <li key={step} className="flex items-center gap-tab-3 rounded-tab-2 border border-border bg-background px-tab-3 py-tab-3 text-[15px]">
                  <span className="size-tab-2 rounded-full bg-foreground" aria-hidden="true" />
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

export function EscapeHatchSection() {
  return (
    <section className="border-b border-border px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto max-w-7xl rounded-[24px] border border-border bg-gradient-to-br from-muted to-background p-tab-6 md:p-tab-8">
        <p className="text-[12px] uppercase tracking-[0.24em] text-muted-foreground">Native escape hatch</p>
        <div className="mt-tab-5 grid gap-tab-6 lg:grid-cols-[1fr_0.8fr] lg:items-end">
          <h2 className="text-[34px] font-semibold leading-tight tracking-[-0.04em] md:text-[56px]">Performance-critical paths stay native.</h2>
          <p className="text-[17px] leading-8 text-muted-foreground">VGPU is a thin set of helpers over GPUDevice, GPUTexture, encoders, passes, and WGSL. Drop to native WebGPU objects at any boundary, profile the real workload, and keep abstractions out of hot paths when needed.</p>
        </div>
      </div>
    </section>
  );
}

export function DocsCtaSection() {
  return (
    <section id="docs" className="px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <p className="text-[12px] uppercase tracking-[0.24em] text-muted-foreground">Docs and artifacts</p>
        <h2 className="mt-tab-3 text-[38px] font-semibold leading-tight tracking-[-0.04em] md:text-[64px]">Start with the repo. Review with images.</h2>
        <p className="mt-tab-4 max-w-2xl text-[17px] leading-8 text-muted-foreground">The site ships with local Storybook exposure, Playwright desktop and mobile PNG generation, and agent-friendly implementation rules in <code className="font-mono text-foreground">apps/vgpu-site/docs</code>.</p>
        <div className="mt-tab-8 flex flex-col gap-tab-3 sm:flex-row">
          <a className="inline-flex h-block-1.5 items-center justify-center rounded-tab-2 bg-foreground px-tab-5 text-[12px] font-medium text-[#050505]" href="/preview">Open component preview</a>
          <a className="inline-flex h-block-1.5 items-center justify-center rounded-tab-2 border border-border px-tab-5 text-[12px] font-medium" href="https://github.com/vercel-labs/vgpu/tree/main/packages">Read packages</a>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border px-tab-5 py-tab-6 text-[12px] text-muted-foreground md:px-tab-8">
      <div className="mx-auto flex max-w-7xl flex-col justify-between gap-tab-3 md:flex-row">
        <p>VGPU standalone site app · apps/vgpu-site</p>
        <p>Built with Next 15, React 18, Tailwind v4, and tw-blocks.</p>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <>
      <Header />
      <main>
        <HeroSection />
        <ComparisonSection />
        <FeaturePillarsSection />
        <WorkflowSection />
        <EscapeHatchSection />
        <DocsCtaSection />
      </main>
      <Footer />
    </>
  );
}
