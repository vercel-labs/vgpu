import { HeroPostFx } from "./hero-post-fx";
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
    <header className="absolute inset-x-0 top-0 z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-tab-5 py-tab-4 text-[0.875rem] text-muted-foreground md:px-tab-8">
      <span className="pointer-events-none absolute inset-x-tab-5 bottom-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent md:inset-x-tab-8" aria-hidden="true" />
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
        className="rounded-tab-2 border border-border px-tab-3 py-tab-1.5 text-[0.875rem] text-foreground transition hover:border-foreground"
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
      <HeroPostFx />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background to-transparent" aria-hidden="true" />
      <div className="pointer-events-none relative z-10 mx-auto flex min-h-[820px] w-full max-w-7xl flex-col items-center justify-center px-tab-5 pb-block-2 pt-[22rem] text-center md:px-tab-8 md:pt-[24rem]">
        <h1 className="max-w-2xl text-balance text-[1.375rem] font-medium leading-[1.18] tracking-[-0.03em] text-foreground md:text-[1.75rem] lg:text-[2rem]">
          <span className="sr-only">VGPU: </span>
          The WebGPU framework for agents
        </h1>
        <p className="mt-tab-4 max-w-2xl text-pretty font-mono text-[1rem] leading-7 text-muted-foreground md:text-[1.0625rem]">
          VGPU gives coding agents clear GPU building blocks, runnable docs, and image artifacts so they can create and review graphics work with you.
        </p>
        <div className="pointer-events-auto mt-tab-7 flex flex-col items-center gap-tab-3">
          <a className="inline-flex h-block-2 items-center justify-center gap-tab-2 rounded-tab-2 bg-foreground px-tab-7 text-[0.9375rem] font-medium text-[#050505] transition hover:bg-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/40" href="https://github.com/vercel-labs/vgpu">
            Get Started <Arrow />
          </a>
          <a className="text-[0.9375rem] font-medium text-foreground/85 underline-offset-4 transition hover:text-foreground hover:underline" href="/llms.txt">
            Read docs
          </a>
        </div>
        <PromptCopy />
      </div>
    </section>
  );
}

function Token({ kind, value }: { readonly kind: string; readonly value: string }) {
  const color =
    kind === "kw"
      ? "text-[#c4b5fd]"
      : kind === "fn"
        ? "text-[#93c5fd]"
        : kind === "str"
          ? "text-[#86efac]"
          : kind === "num"
            ? "text-[#fbbf24]"
            : "text-[#d4d4d8]";
  return <span className={color}>{value}</span>;
}

function CodePanel({ title, eyebrow, code }: { readonly title: string; readonly eyebrow: string; readonly code: readonly (readonly [string, string])[] }) {
  return (
    <article className="overflow-hidden rounded-site border border-border bg-muted/70 shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-border px-tab-4 py-tab-3">
        <div>
          <p className="text-[0.875rem] uppercase tracking-[0.24em] text-muted-foreground">{eyebrow}</p>
          <h3 className="mt-tab-1 text-balance text-[0.9375rem] font-medium text-foreground">{title}</h3>
        </div>
        <div className="flex gap-tab-1.5" aria-hidden="true">
          <span className="size-tab-2 rounded-full bg-[#3f3f46]" />
          <span className="size-tab-2 rounded-full bg-[#71717a]" />
          <span className="size-tab-2 rounded-full bg-[#f4f4f5]" />
        </div>
      </div>
      <pre className="min-h-[360px] overflow-x-auto p-tab-4 text-left font-mono text-[0.875rem] leading-6"><code>{code.map(([kind, value], index) => <Token key={`${kind}-${index}`} kind={kind} value={value} />)}</code></pre>
    </article>
  );
}

export function ComparisonSection() {
  return (
    <section id="workflow-code" className="border-b border-border px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-tab-8 max-w-3xl">
          <p className="text-[0.875rem] uppercase tracking-[0.24em] text-muted-foreground">WebGPU code paths</p>
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
            <p className="text-[0.875rem] uppercase tracking-[0.24em] text-muted-foreground">Feature pillars</p>
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

const runtimes = [
  { label: "Browser", detail: "interactive GPU UI", position: "left-[7%] top-[18%]", icon: "browser" },
  { label: "Next.js", detail: "product routes", position: "right-[8%] top-[16%]", icon: "next" },
  { label: "Node", detail: "headless snapshots", position: "left-[10%] bottom-[16%]", icon: "node" },
  { label: "Docker", detail: "CI verification", position: "right-[9%] bottom-[18%]", icon: "docker" },
] as const;

function RuntimeGlyph({ icon }: { readonly icon: (typeof runtimes)[number]["icon"] }) {
  const paths = {
    browser: "M16 24h68v50H16zM16 36h68M27 30h2M37 30h2M47 30h2",
    next: "M24 76V24l36 52V24M72 24v52",
    node: "M50 14 80 31v38L50 86 20 69V31zM38 42v18M50 36v28M62 42v18",
    docker: "M18 54h54l8-12 8 12h-8c0 19-14 30-34 30H30c-8 0-12-6-12-14zM30 34h10v10H30zM42 34h10v10H42zM54 34h10v10H54zM42 22h10v10H42z",
  }[icon];

  return (
    <svg aria-hidden="true" className="size-tab-8 text-foreground/80" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths} />
    </svg>
  );
}

export function WorkflowSection() {
  return (
    <section id="workflow" className="px-tab-5 py-block-3 md:px-tab-8">
      <div className="mx-auto grid max-w-7xl gap-tab-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
        <div>
          <p className="text-[0.875rem] uppercase tracking-[0.24em] text-muted-foreground">Works anywhere</p>
          <h2 className="mt-tab-3 text-balance text-[2.25rem] font-semibold leading-tight tracking-[-0.04em] md:text-[3.5rem]">One GPU story across every runtime.</h2>
          <p className="mt-tab-4 text-pretty text-[1.0625rem] leading-8 text-muted-foreground">VGPU keeps the render path portable: design in the browser, ship through Next.js, verify in Node, and preserve artifacts in Docker-backed CI.</p>
        </div>
        <div className="relative min-h-[460px] overflow-hidden rounded-site border border-border bg-muted/30 p-tab-5">
          <div className="absolute left-1/2 top-1/2 h-px w-[72%] -translate-x-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent" aria-hidden="true" />
          <div className="absolute left-1/2 top-1/2 h-[72%] w-px -translate-y-1/2 bg-gradient-to-b from-transparent via-white/30 to-transparent" aria-hidden="true" />
          <div className="absolute left-1/2 top-1/2 h-[62%] w-px -translate-x-1/2 -translate-y-1/2 rotate-45 bg-gradient-to-b from-transparent via-white/20 to-transparent" aria-hidden="true" />
          <div className="absolute left-1/2 top-1/2 h-[62%] w-px -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-gradient-to-b from-transparent via-white/20 to-transparent" aria-hidden="true" />

          <div className="absolute left-1/2 top-1/2 grid size-block-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-background shadow-2xl shadow-black/50">
            <span className="font-pixel text-[2.25rem] tracking-[-0.06em] text-foreground">vgpu</span>
          </div>

          {runtimes.map((runtime) => (
            <article key={runtime.label} className={`absolute ${runtime.position} w-[11.5rem] rounded-site border border-border bg-background/90 p-tab-4 shadow-xl shadow-black/30 backdrop-blur`}>
              <div className="flex items-center gap-tab-3">
                <RuntimeGlyph icon={runtime.icon} />
                <div>
                  <h3 className="text-[1rem] font-medium text-foreground">{runtime.label}</h3>
                  <p className="mt-tab-1 text-pretty text-[0.875rem] leading-5 text-muted-foreground">{runtime.detail}</p>
                </div>
              </div>
            </article>
          ))}
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
