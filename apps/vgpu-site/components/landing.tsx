import { PromptCopy } from "./prompt-copy";
import { vgpuDotMap } from "./vgpu-dot-map";
import { VgpuPixelHero } from "./vgpu-pixel-hero";

const nativeLines = [
  ["kw", "const"], ["txt", " bindGroupLayout = device."], ["fn", "createBindGroupLayout"], ["txt", "({"],
  ["txt", "\n  entries: ["],
  ["txt", "\n    { binding: "], ["num", "0"], ["txt", ", visibility: GPUShaderStage.COMPUTE, buffer: { type: "], ["str", "\"storage\""], ["txt", " } },"],
  ["txt", "\n    { binding: "], ["num", "1"], ["txt", ", visibility: GPUShaderStage.COMPUTE, buffer: { type: "], ["str", "\"uniform\""], ["txt", " } },"],
  ["txt", "\n  ],"],
  ["txt", "\n});\n\n"],
  ["kw", "const"], ["txt", " encoder = device."], ["fn", "createCommandEncoder"], ["txt", "();\n"],
  ["kw", "const"], ["txt", " pass = encoder."], ["fn", "beginComputePass"], ["txt", "();\n"],
  ["txt", "pass."], ["fn", "setPipeline"], ["txt", "(pipeline);\n"],
  ["txt", "pass."], ["fn", "setBindGroup"], ["txt", "("], ["num", "0"], ["txt", ", bindGroup);\n"],
  ["txt", "pass."], ["fn", "dispatchWorkgroups"], ["txt", "(width, height);\npass."], ["fn", "end"], ["txt", "();"],
] as const;

const vgpuLines = [
  ["kw", "const"], ["txt", " layout = bind."], ["fn", "group"], ["txt", "({"],
  ["txt", "\n  particles: "], ["fn", "storageBuffer"], ["txt", "({ readWrite: "], ["kw", "true"], ["txt", " }),"],
  ["txt", "\n  params: "], ["fn", "uniformBuffer"], ["txt", "<SimParams>(),"],
  ["txt", "\n});\n\n"],
  ["kw", "await"], ["txt", " frame(device)\n  ."], ["fn", "compute"], ["txt", "(pipeline, layout."], ["fn", "bind"], ["txt", "({ particles, params }))\n  ."],
  ["fn", "dispatch"], ["txt", "({ x: width, y: height })\n  ."], ["fn", "snapshot"], ["txt", "("], ["str", "\"particles-step.png\""], ["txt", ");"],
] as const;

const pillars = [
  {
    title: "Typed GPU setup",
    body: "Keep buffers, textures, and bind groups named and readable so agents can safely edit the render path.",
    icon: "layout",
  },
  {
    title: "Browser rendering",
    body: "Use VGPU helpers around the same WebGPU objects your app ships to customers.",
    icon: "browser",
  },
  {
    title: "Node.js snapshots",
    body: "Render deterministic images in headless runs so CI and agents can review visual changes.",
    icon: "node",
  },
  {
    title: "WGSL utilities",
    body: "Small shader modules and docs keep GPU code approachable for humans and coding agents.",
    icon: "shader",
  },
  {
    title: "Native escape hatch",
    body: "Drop to GPUDevice, encoders, passes, and textures whenever the abstraction stops helping.",
    icon: "native",
  },
  {
    title: "Artifact-first review",
    body: "Commit screenshots and snapshots that explain what changed without requiring a live GPU session.",
    icon: "artifact",
  },
] as const;

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function VercelMark() {
  return (
    <svg aria-hidden="true" className="size-tab-3 text-foreground" viewBox="0 0 100 100" fill="currentColor">
      <path d="M50 10 95 90H5L50 10Z" />
    </svg>
  );
}

function FeatureIcon({ type }: { readonly type: (typeof pillars)[number]["icon"] }) {
  const path = {
    layout: "M18 24h44v18H18zM18 50h20v26H18zM46 50h16v26H46z",
    browser: "M14 22h72v56H14zM14 34h72M25 28h2M35 28h2M45 28h2",
    node: "M50 12 82 30v40L50 88 18 70V30zM34 39v22M50 34v32M66 39v22",
    shader: "M18 70c20-42 44 42 64 0M22 30h56M30 46h40",
    native: "M22 22h56v56H22zM34 34h32v32H34zM43 12v14M57 12v14M43 74v14M57 74v14M12 43h14M12 57h14M74 43h14M74 57h14",
    artifact: "M24 16h38l14 14v54H24zM62 16v14h14M34 46h32M34 60h24M34 74h30",
  }[type];

  return (
    <div className="grid size-block-1.5 place-items-center rounded-tab-3 border border-white/10 bg-white/[0.035] transition group-hover:border-white/30 group-hover:bg-white/[0.07]" aria-hidden="true">
      <svg className="size-tab-8 text-foreground/80" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </div>
  );
}

export function Header() {
  return (
    <header className="absolute inset-x-0 top-0 z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-tab-5 py-tab-4 text-[0.75rem] text-muted-foreground md:px-tab-8">
      <a href="#top" className="flex items-center gap-tab-2 text-foreground" aria-label="VGPU home">
        <VercelMark />
        <span className="font-medium tracking-tight">VGPU</span>
      </a>
      <nav className="hidden items-center gap-tab-6 md:flex" aria-label="Primary navigation">
        <a className="transition hover:text-foreground" href="#features">Features</a>
        <a className="transition hover:text-foreground" href="#workflow">Workflow</a>
        <a className="transition hover:text-foreground" href="/llms.txt">Docs</a>
      </nav>
      <a
        className="rounded-tab-2 border border-border px-tab-3 py-tab-1.5 text-[0.75rem] text-foreground transition hover:border-foreground"
        href="https://github.com/vercel-labs/vgpu"
      >
        GitHub
      </a>
    </header>
  );
}

export function HeroSection() {
  return (
    <section id="top" className="relative isolate min-h-[820px] overflow-hidden border-b border-border">
      <VgpuPixelHero dotMap={vgpuDotMap} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,0.13),transparent_30rem)]" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background to-transparent" aria-hidden="true" />
      <div className="relative z-10 mx-auto flex min-h-[820px] w-full max-w-7xl flex-col items-center justify-center px-tab-5 pb-block-2 pt-[22rem] text-center md:px-tab-8 md:pt-[24rem]">
        <h1 className="max-w-2xl text-balance font-mono text-[1.375rem] font-medium leading-[1.18] tracking-[-0.03em] text-foreground md:text-[1.75rem] lg:text-[2rem]">
          <span className="sr-only">VGPU: </span>
          The WebGPU framework for agents
        </h1>
        <p className="mt-tab-4 max-w-2xl text-pretty text-[1rem] leading-7 text-muted-foreground md:text-[1.0625rem]">
          VGPU gives coding agents clear GPU building blocks, runnable docs, and image artifacts so they can create and review graphics work with you.
        </p>
        <div className="mt-tab-7 flex flex-col items-center gap-tab-3 sm:flex-row">
          <a className="inline-flex h-block-2 items-center justify-center gap-tab-2 rounded-tab-2 bg-foreground px-tab-7 text-[0.9375rem] font-medium text-[#050505] transition hover:bg-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/40" href="https://github.com/vercel-labs/vgpu">
            Get Started <Arrow />
          </a>
          <a className="inline-flex h-block-2 items-center justify-center px-tab-4 text-[0.9375rem] font-medium text-foreground/85 underline-offset-4 transition hover:text-foreground hover:underline" href="/llms.txt">
            Read docs
          </a>
        </div>
        <PromptCopy />
      </div>
    </section>
  );
}

function Token({ kind, value }: { readonly kind: string; readonly value: string }) {
  const color = kind === "kw" ? "text-[#f4f4f5]" : kind === "fn" ? "text-[#d4d4d8]" : kind === "str" ? "text-[#c7c7cc]" : kind === "num" ? "text-[#e4e4e7]" : "text-[#a1a1aa]";
  return <span className={color}>{value}</span>;
}

function CodePanel({ title, eyebrow, code }: { readonly title: string; readonly eyebrow: string; readonly code: readonly (readonly [string, string])[] }) {
  return (
    <article className="overflow-hidden rounded-site border border-border bg-muted/70 shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-border px-tab-4 py-tab-3">
        <div>
          <p className="text-[0.75rem] uppercase tracking-[0.24em] text-muted-foreground">{eyebrow}</p>
          <h3 className="mt-tab-1 text-balance text-[0.9375rem] font-medium text-foreground">{title}</h3>
        </div>
        <div className="flex gap-tab-1.5" aria-hidden="true">
          <span className="size-tab-2 rounded-full bg-[#3f3f46]" />
          <span className="size-tab-2 rounded-full bg-[#71717a]" />
          <span className="size-tab-2 rounded-full bg-[#f4f4f5]" />
        </div>
      </div>
      <pre className="min-h-[360px] overflow-x-auto p-tab-4 text-left font-mono text-[0.8125rem] leading-6"><code>{code.map(([kind, value], index) => <Token key={`${kind}-${index}`} kind={kind} value={value} />)}</code></pre>
    </article>
  );
}

export function ComparisonSection() {
  return (
    <section id="workflow-code" className="border-b border-border px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-tab-8 max-w-3xl">
          <p className="text-[0.75rem] uppercase tracking-[0.24em] text-muted-foreground">WebGPU code paths</p>
          <h2 className="mt-tab-3 text-balance text-[2.25rem] font-semibold leading-tight tracking-[-0.04em] md:text-[3.5rem]">Less ceremony, same escape hatch.</h2>
          <p className="mt-tab-4 text-pretty text-[1.0625rem] leading-8 text-muted-foreground">VGPU keeps the real GPU objects visible, then gives agents compact helpers around the code they repeat every frame.</p>
        </div>
        <div className="grid gap-tab-4 lg:grid-cols-2">
          <CodePanel eyebrow="Native WebGPU" title="Manual descriptors and pass wiring" code={nativeLines} />
          <CodePanel eyebrow="VGPU" title="Typed helpers around the same GPU objects" code={vgpuLines} />
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
            <p className="text-[0.75rem] uppercase tracking-[0.24em] text-muted-foreground">Feature pillars</p>
            <h2 className="mt-tab-3 text-balance text-[2.25rem] font-semibold leading-tight tracking-[-0.04em] md:text-[3.5rem]">Small primitives that cover the GPU loop.</h2>
          </div>
          <p className="max-w-md text-pretty text-[1rem] leading-7 text-muted-foreground">Each primitive is designed for inspection first: readable labels, explicit resources, and native WebGPU access when the abstraction stops helping.</p>
        </div>
        <div className="mt-tab-8 grid gap-tab-3 md:grid-cols-2 lg:grid-cols-3">
          {pillars.map((pillar) => (
            <article key={pillar.title} className="group min-h-block-5 rounded-site border border-border bg-muted/45 p-tab-5 transition hover:border-[#52525b] hover:bg-muted/70 hover:shadow-2xl hover:shadow-white/[0.035]">
              <FeatureIcon type={pillar.icon} />
              <h3 className="mt-tab-8 text-balance text-[1.25rem] font-semibold tracking-[-0.02em]">{pillar.title}</h3>
              <p className="mt-tab-3 text-pretty text-[0.9375rem] leading-7 text-muted-foreground">{pillar.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function WorkflowSection() {
  const steps = ["Render interactive WebGPU scenes in the browser", "Run the same examples through Node.js/headless adapters", "Write PNG artifacts for agents and reviewers", "Keep the native WebGPU path available for profiling"];

  return (
    <section id="workflow" className="px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto grid max-w-7xl gap-tab-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <p className="text-[0.75rem] uppercase tracking-[0.24em] text-muted-foreground">Browser + Node.js</p>
          <h2 className="mt-tab-3 text-balance text-[2.25rem] font-semibold leading-tight tracking-[-0.04em] md:text-[3.5rem]">Render on the web. Verify in Node.js.</h2>
          <p className="mt-tab-4 text-pretty text-[1.0625rem] leading-8 text-muted-foreground">VGPU is built for product UI and automated review: agents can edit GPU code, run docs locally, and attach deterministic images to the pull request.</p>
        </div>
        <div className="rounded-site border border-border bg-background p-tab-3">
          <div className="rounded-tab-3 border border-border bg-muted p-tab-5">
            <div className="flex items-center justify-between border-b border-border pb-tab-4">
              <div>
                <p className="text-[0.75rem] uppercase tracking-[0.24em] text-muted-foreground">Render loop</p>
                <h3 className="mt-tab-1 text-balance text-[1.125rem] font-medium">One story, two runtimes</h3>
              </div>
              <span className="rounded-full border border-border px-tab-2 py-tab-1 text-[0.75rem] text-muted-foreground">CI ready</span>
            </div>
            <ol className="mt-tab-5 space-y-tab-3">
              {steps.map((step) => (
                <li key={step} className="flex items-center gap-tab-3 rounded-tab-2 border border-border bg-background px-tab-3 py-tab-3 text-pretty text-[0.9375rem]">
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

export function LandingPage() {
  return (
    <>
      <Header />
      <main>
        <HeroSection />
        <ComparisonSection />
        <FeaturePillarsSection />
        <WorkflowSection />
      </main>
    </>
  );
}
