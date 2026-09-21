import { CiRunOutput } from "./ci-run-output";
import { DeferredImage } from "./deferred-image";
import { EveVideo } from "./eve-video";

const eveBillboardImage = "/examples/eve/eve-billboard.png";
const eveBillboardLayout = "/examples/eve/hudson-yards-billboard.svg";
const eveBillboardRender = "/examples/eve/eve-billboard-8k.png";
const eveHomepageImage = "/examples/eve/eve-dev-home.png";
const outputConnectorKeys = ["web", "image", "video", "ci"] as const;

const outputFrameClass =
  "relative z-10 overflow-hidden rounded-card border border-gray-alpha-400 bg-background-100 shadow-[0_24px_64px_rgba(0,0,0,0.12)]";

function FrameLabel({ detail, name }: { detail: string; name: string }) {
  return (
    <div className="flex h-9 items-center justify-between border-b border-gray-alpha-400 px-3 font-mono text-[10px] uppercase tracking-[0.16em] text-gray-900">
      <span className="text-gray-1000">{name}</span>
      <span>{detail}</span>
    </div>
  );
}

function EveMark({ alt }: { alt: string }) {
  return (
    <DeferredImage
      alt={alt}
      className="object-contain"
      fetchPriority="low"
      fill
      loading="lazy"
      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 34vw"
      src={eveBillboardImage}
    />
  );
}

function WebOutput() {
  return (
    <article className={outputFrameClass}>
      <FrameLabel detail="interactive · canvas" name="Web" />
      <div className="relative aspect-video">
        <DeferredImage
          alt="Eve homepage using the Eve shader in an interactive web canvas"
          className="object-cover object-top"
          fetchPriority="low"
          fill
          loading="lazy"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 34vw"
          src={eveHomepageImage}
        />
      </div>
    </article>
  );
}

function ImageOutput() {
  return (
    <article className={outputFrameClass}>
      <FrameLabel detail="png · 8192 × 4608" name="Image" />
      <div className="relative flex aspect-video items-center bg-black">
        <div className="relative aspect-[48/14] w-full overflow-hidden">
          <DeferredImage
            alt="Hudson Yards billboard layout for Eve"
            className="object-fill"
            fetchPriority="low"
            fill
            loading="lazy"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 34vw"
            src={eveBillboardLayout}
            unoptimized
          />
          <div className="absolute left-[30.1%] top-[15.6%] h-[68.8%] w-[64.3%] overflow-hidden">
            <DeferredImage
              alt="High-resolution Eve shader render on the Hudson Yards billboard"
              className="object-contain"
              fetchPriority="low"
              fill
              loading="lazy"
              sizes="(max-width: 640px) 64vw, (max-width: 1024px) 32vw, 22vw"
              src={eveBillboardRender}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

function VideoOutput() {
  return (
    <article className={outputFrameClass}>
      <FrameLabel detail="mp4 · 60 fps" name="Video" />
      <EveVideo />
    </article>
  );
}

function CiOutput() {
  return (
    <article className={outputFrameClass}>
      <FrameLabel detail="headless · artifact" name="CI" />
      <CiRunOutput />
    </article>
  );
}

function SourceCard() {
  return (
    <div className="w-full overflow-hidden rounded-card border border-gray-alpha-400 bg-background-100 shadow-[0_24px_64px_rgba(0,0,0,0.12)]">
      <div className="flex h-10 items-center justify-between border-b border-gray-alpha-400 px-4 font-mono text-[11px] text-gray-900">
        <span className="text-gray-1000">eve.ts</span>
      </div>
      <pre className="overflow-x-auto px-4 py-5 font-mono text-[12px] leading-[1.8] text-gray-1000 sm:px-5 sm:text-[13px]">
        <code>
          <span className="text-red-800 dark:text-[#ff518d]">import</span>
          {" { effect } "}
          <span className="text-red-800 dark:text-[#ff518d]">from</span>{" "}
          <span className="text-green-800 dark:text-[#00ca52]">
            &quot;vgpu&quot;
          </span>
          {";\n\n"}
          <span className="text-red-800 dark:text-[#ff518d]">const</span>
          {" eve = "}
          <span className="text-purple-800 dark:text-[#c472fb]">effect</span>
          {"(gpu, eveWgsl);\neve."}
          <span className="text-purple-800 dark:text-[#c472fb]">draw</span>
          {"({ target });"}
        </code>
      </pre>
    </div>
  );
}

function OutputConnectors() {
  return (
    <div
      aria-hidden="true"
      className="relative h-14 text-gray-alpha-600 lg:h-20"
    >
      <span className="absolute inset-y-0 left-1/2 w-px bg-current lg:hidden" />

      <div className="absolute inset-0 hidden lg:block">
        <span className="absolute bottom-1/2 left-1/2 top-0 w-px bg-current" />
        <span className="absolute left-[calc(12.5%-0.375rem)] right-[calc(12.5%-0.375rem)] top-1/2 h-px bg-current" />

        <div className="absolute inset-0 grid grid-cols-4 gap-4">
          {outputConnectorKeys.map((output) => (
            <span className="relative" key={output}>
              <span className="absolute bottom-0 left-1/2 top-1/2 w-px bg-current" />
              <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OneShaderEverySurfaceSection() {
  return (
    <section aria-labelledby="one-shader-heading" className="mb-36">
      <div className="mb-12 flex flex-col items-center text-center sm:mb-14">
        <h2
          className="text-pretty text-3xl font-normal leading-[1.05] tracking-[-0.045em] text-gray-1000 sm:text-5xl sm:leading-tight"
          id="one-shader-heading"
        >
          One shader. Render everywhere.
        </h2>
        <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-gray-900 md:text-lg">
          Use the same shader in the browser and headless Node.js. Make it
          interactive, render it at any resolution, turn it into video, or run
          tests on your CI.
        </p>
      </div>

      <div className="-mx-6 bg-background-200 px-6 lg:-mx-12 lg:px-12">
        <div className="mx-auto w-full max-w-md">
          <SourceCard />
        </div>

        <OutputConnectors />

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <WebOutput />
          <ImageOutput />
          <VideoOutput />
          <CiOutput />
        </div>
      </div>
    </section>
  );
}
