import { Braces, Cpu, FileImage, Globe, Layers3, Monitor, Server, Ship, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { HeroPostFx } from "./hero-post-fx";
import { PromptCopy } from "./prompt-copy";
import { WorkflowCanvas } from "./workflow-canvas";
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
    icon: Layers3,
  },
  {
    title: "Browser rendering",
    body: "Use VGPU helpers around the same WebGPU objects your app ships to customers.",
    icon: Monitor,
  },
  {
    title: "Node.js snapshots",
    body: "Render deterministic images in headless runs so CI and agents can review visual changes.",
    icon: Server,
  },
  {
    title: "WGSL utilities",
    body: "Small shader modules and docs keep GPU code approachable for humans and coding agents.",
    icon: Braces,
  },
  {
    title: "Native escape hatch",
    body: "Drop to GPUDevice, encoders, passes, and textures whenever the abstraction stops helping.",
    icon: Cpu,
  },
  {
    title: "Artifact-first review",
    body: "Commit screenshots and snapshots that explain what changed without requiring a live GPU session.",
    icon: FileImage,
  },
] as const;

const runtimes = [
  { label: "Browser", detail: "interactive GPU UI", icon: Globe },
  { label: "Next.js", detail: "product routes", icon: Sparkles },
  { label: "Node", detail: "headless snapshots", icon: Server },
  { label: "Docker", detail: "CI verification", icon: Ship },
] as const;

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function VercelMark() {
  return (
    <svg aria-hidden="true" className="size-4 text-foreground" viewBox="0 0 100 100" fill="currentColor">
      <path d="M50 10 95 90H5L50 10Z" />
    </svg>
  );
}

function Eyebrow({ children }: { readonly children: string }) {
  return <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{children}</p>;
}

function SectionHeader({ eyebrow, title, body, centered = false }: { readonly eyebrow?: string; readonly title: string; readonly body?: string; readonly centered?: boolean }) {
  return (
    <div className={centered ? "mx-auto max-w-3xl text-center" : "max-w-3xl"}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className={`${eyebrow ? "mt-4" : ""} text-balance text-3xl font-semibold leading-tight tracking-[-0.03em] text-foreground md:text-4xl`}>
        {title}
      </h2>
      {body ? <p className="mt-5 text-balance text-base leading-8 text-muted-foreground md:text-lg">{body}</p> : null}
    </div>
  );
}

function IconSurface({ icon: Icon }: { readonly icon: LucideIcon }) {
  return (
    <div className="grid size-11 place-items-center rounded-xl border border-white/10 bg-white/[0.035] text-foreground/80 transition group-hover:border-white/20 group-hover:bg-white/[0.065]" aria-hidden="true">
      <Icon className="size-5" strokeWidth={1.8} />
    </div>
  );
}

export function Header() {
  return (
    <header className="absolute inset-x-0 top-0 z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 text-sm text-muted-foreground md:px-8">
      <span className="pointer-events-none absolute inset-x-5 bottom-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent md:inset-x-8" aria-hidden="true" />
      <a href="#top" className="flex items-center gap-2.5 text-foreground" aria-label="VGPU home">
        <VercelMark />
        <span className="font-medium tracking-tight">VGPU</span>
      </a>
      <nav className="hidden items-center gap-7 md:flex" aria-label="Primary navigation">
        <a className="transition hover:text-foreground" href="#features">Features</a>
        <a className="transition hover:text-foreground" href="#workflow">Workflow</a>
        <a className="transition hover:text-foreground" href="/llms.txt">Docs</a>
      </nav>
      <a
        className="inline-flex h-9 items-center rounded-full border border-border bg-background/45 px-4 font-medium text-foreground shadow-sm shadow-black/30 backdrop-blur transition hover:border-white/35 hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-foreground/30"
        href="https://github.com/vercel-labs/vgpu"
      >
        GitHub
      </a>
    </header>
  );
}

export function HeroSection() {
  return (
    <section id="top" className="relative isolate min-h-[var(--hero-min-height)] overflow-hidden border-b border-border/80">
      <VgpuPixelHero dotMap={vgpuDotMap} />
      <HeroPostFx />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-background via-background/75 to-transparent" aria-hidden="true" />
      <div className="pointer-events-none relative z-10 mx-auto flex min-h-[var(--hero-min-height)] w-full max-w-7xl flex-col items-center justify-center px-5 pb-20 pt-[calc(var(--hero-content-offset)-1rem)] text-center md:px-8 md:pt-[var(--hero-content-offset)]">
        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">GPU primitives for agentic workflows</p>
          <h1 className="mt-4 text-balance text-2xl font-semibold leading-tight tracking-[-0.03em] text-foreground md:text-3xl">
            <span className="sr-only">VGPU: </span>
            The WebGPU framework for agents
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-7 text-muted-foreground">
            VGPU gives coding agents clear GPU building blocks, runnable docs, and image artifacts so they can create and review graphics work with you.
          </p>
        </div>
        <div className="pointer-events-auto mt-7 flex flex-col items-center gap-3">
          <a className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-foreground px-6 text-sm font-medium text-background shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_16px_48px_rgba(255,255,255,0.12)] transition hover:bg-foreground/90 focus:outline-none focus:ring-2 focus:ring-foreground/40" href="https://github.com/vercel-labs/vgpu">
            Get Started <Arrow />
          </a>
          <a className="text-sm font-medium text-foreground/80 underline-offset-4 transition hover:text-foreground hover:underline" href="/llms.txt">
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
      ? "text-[#d8b4fe]"
      : kind === "fn"
        ? "text-[#93c5fd]"
        : kind === "str"
          ? "text-[#86efac]"
          : kind === "num"
            ? "text-[#fde68a]"
            : "text-[#e4e4e7]";
  return <span className={color}>{value}</span>;
}

function CodePanel({ title, eyebrow, code }: { readonly title: string; readonly eyebrow: string; readonly code: readonly (readonly [string, string])[] }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-2xl shadow-black/45 ring-1 ring-white/[0.03]">
      <div className="flex items-start justify-between gap-6 border-b border-border bg-white/[0.025] px-5 py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
          <h3 className="mt-2 text-balance text-base font-medium text-foreground">{title}</h3>
        </div>
        <div className="mt-1 flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-[#3f3f46]" />
          <span className="size-2.5 rounded-full bg-[#71717a]" />
          <span className="size-2.5 rounded-full bg-[#f4f4f5]" />
        </div>
      </div>
      <pre className="min-h-[360px] overflow-x-auto p-5 text-left font-mono text-sm leading-6 [tab-size:2]"><code>{code.map(([kind, value], index) => <Token key={`${kind}-${index}`} kind={kind} value={value} />)}</code></pre>
    </article>
  );
}

export function ComparisonSection() {
  return (
    <section id="workflow-code" className="relative border-b border-border/80 px-5 py-[var(--section-y)] md:px-8 md:py-[calc(var(--section-y)+2rem)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" aria-hidden="true" />
      <div className="mx-auto max-w-7xl">
        <SectionHeader
          eyebrow="WebGPU code paths"
          title="Designed to ship faster and securely"
          body="VGPU keeps the real GPU objects visible, then gives agents compact helpers around the code they repeat every frame."
        />
        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <CodePanel eyebrow="VGPU" title="Typed helpers around the same GPU objects" code={vgpuLines} />
          <CodePanel eyebrow="Native WebGPU" title="Manual descriptors and pass wiring" code={nativeLines} />
        </div>
      </div>
    </section>
  );
}

export function FeaturePillarsSection() {
  return (
    <section id="features" className="relative border-b border-border/80 px-5 py-[var(--section-y)] md:px-8 md:py-[calc(var(--section-y)+2rem)]">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
          <SectionHeader eyebrow="Feature pillars" title="Small primitives that cover the GPU loop." />
          <p className="max-w-md text-pretty text-base leading-8 text-muted-foreground">Each primitive is designed for inspection first: readable labels, explicit resources, and native WebGPU access when the abstraction stops helping.</p>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {pillars.map((pillar) => (
            <article key={pillar.title} className="group min-h-64 rounded-2xl border border-border-strong bg-card p-6 shadow-sm shadow-black/20 ring-1 ring-white/[0.02] transition hover:border-white/20 hover:bg-card-hover">
              <IconSurface icon={pillar.icon} />
              <h3 className="mt-8 text-balance text-xl font-semibold tracking-[-0.02em] text-foreground">{pillar.title}</h3>
              <p className="mt-3 text-pretty text-sm leading-7 text-muted-foreground">{pillar.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function RuntimeGlyph({ icon: Icon }: { readonly icon: LucideIcon }) {
  return <Icon className="size-5 text-foreground/80" strokeWidth={1.8} aria-hidden="true" />;
}

export function WorkflowSection() {
  return (
    <section id="workflow" className="px-5 py-[var(--section-y)] md:px-8 md:py-[calc(var(--section-y)+2rem)]">
      <div className="mx-auto max-w-7xl">
        <SectionHeader
          centered
          title="runs anywhere"
          body="Design in the browser, ship through Next.js, verify in Node, and preserve artifacts in Docker-backed CI."
        />
        <div className="relative mx-auto mt-12 min-h-[520px] max-w-5xl overflow-hidden rounded-3xl border border-border-strong bg-card p-5 shadow-2xl shadow-black/30 ring-1 ring-white/[0.02] md:min-h-[560px]">
          <WorkflowCanvas />
          <div className="absolute left-1/2 top-1/2 z-10 grid size-36 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-transparent md:size-44">
            <span className="font-pixel text-2xl tracking-[-0.06em] text-foreground drop-shadow-[0_0_18px_rgba(255,255,255,0.28)] md:text-3xl">vgpu</span>
          </div>

          <div className="relative z-20 grid min-h-[480px] gap-4 md:min-h-[520px] md:grid-cols-2 md:grid-rows-2">
            {runtimes.map((runtime, index) => (
              <article
                key={runtime.label}
                className={`flex items-center rounded-2xl border border-white/10 bg-background/70 p-4 shadow-xl shadow-black/30 backdrop-blur-md transition hover:border-white/20 hover:bg-card-hover ${index % 2 === 0 ? "md:justify-self-start" : "md:justify-self-end"} ${index < 2 ? "md:self-start" : "md:self-end"} md:w-64`}
              >
                <div className="flex items-center gap-3">
                  <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.035]">
                    <RuntimeGlyph icon={runtime.icon} />
                  </div>
                  <div>
                    <h3 className="text-base font-medium text-foreground">{runtime.label}</h3>
                    <p className="mt-1 text-pretty text-sm leading-5 text-muted-foreground">{runtime.detail}</p>
                  </div>
                </div>
              </article>
            ))}
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
