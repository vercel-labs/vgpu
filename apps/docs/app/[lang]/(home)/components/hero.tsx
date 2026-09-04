import { HeroTabProvider } from "@/components/hero/hero-tab-state";
import { Button } from "@/components/ui/button";
import { VgpuWordmarkGlyphs } from "@/components/vgpu-wordmark";
import DynamicLink from "fumadocs-core/dynamic-link";
import { preload } from "react-dom";
import { HeroTabs } from "./hero-tabs";
import { WALL_GLOBAL_LIGHT_MASK_URL } from "./prism-background/pipelines/light/assets/manifest";
import { PrismBackground } from "./prism-background/prism-background";
import "../hero-glass-button.css";
import "../hero-theme.css";

interface HeroProps {
  readonly canvasEnabled: boolean;
}

/**
 * Landing hero.
 *
 * The prism scene is a client-owned WebGPU background. The rest of the hero
 * stays server-rendered and layered above it.
 */
export function Hero({ canvasEnabled }: HeroProps) {
  if (canvasEnabled) {
    preload(WALL_GLOBAL_LIGHT_MASK_URL, {
      as: "fetch",
      crossOrigin: "anonymous",
      fetchPriority: "high",
      type: "image/webp",
    });
  }

  return (
    <HeroTabProvider>
      <section
        data-hero-theme
        className="relative -mt-16 min-h-svh overflow-hidden min-[768px]:h-svh min-[768px]:max-h-[80em] min-[768px]:min-h-0"
      >
        <PrismBackground enabled={canvasEnabled} />

        {/* Only the lower edge dissolves into the regular page surface. The
          canvas itself spans the full hero, including the space behind the
          transparent navbar. */}
        <div
          data-hero-overlay
          data-hero-foot-fade
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[16%]"
        />

        <div
          data-hero-container
          className="relative z-10 mx-auto min-h-svh w-full max-w-[1448px] overflow-hidden min-[768px]:h-full min-[768px]:min-h-0"
        >
          {/* The HTML takes a fixed content column on desktop; the invisible
            triangle container receives every remaining pixel inside this
            bounded container. Its viewport-relative bounds position the prism
            on the full-bleed canvas, including on very wide screens.

            The overlay is pointer-events-none so it never eats clicks over the
            rest of the hero, but the content opts back IN. */}
          <div
            data-hero-overlay
            className="pointer-events-none relative z-10 grid min-h-svh grid-cols-1 grid-rows-[auto_1fr] gap-8 px-6 pb-6 pt-24 min-[768px]:absolute min-[768px]:inset-0 min-[768px]:min-h-0 min-[768px]:grid-rows-1 min-[768px]:gap-0 min-[768px]:py-[clamp(3rem,8svh,6rem)] min-[768px]:justify-items-start min-[1100px]:grid-cols-[minmax(0,26em)_minmax(0,1fr)] min-[1100px]:gap-[clamp(2rem,5vw,5rem)]"
          >
            <div className="pointer-events-auto relative z-10 col-start-1 row-start-2 flex h-full flex-col items-center self-start justify-self-center min-[768px]:row-start-1 min-[768px]:h-auto min-[768px]:items-start min-[768px]:self-center min-[768px]:justify-self-start min-[1100px]:col-start-1 min-[1100px]:row-start-1">
              <h1
                aria-label="vgpu"
                data-hero-title
                className="mb-7 aspect-[179.2/75] w-[144px] min-[768px]:mb-[1em] min-[768px]:w-[200px]"
              >
                <svg
                  aria-hidden="true"
                  className="block size-full"
                  fill="currentColor"
                  viewBox="0 0 179.2 75"
                >
                  <VgpuWordmarkGlyphs />
                </svg>
              </h1>
              <p className="max-w-[10em] text-3xl text-balance text-center font-light leading-tight min-[768px]:text-left min-[768px]:text-4xl">
                The WebGPU library, designed for agents.
              </p>
              <div className="mt-auto w-full max-w-[28em] min-[768px]:mt-7">
                <HeroTabs />
              </div>
              <div
                hidden
                className="mt-8 flex flex-wrap items-center justify-center gap-3 min-[768px]:justify-start"
              >
                <Button
                  asChild
                  size="lg"
                  className="bg-white text-black hover:bg-white/90"
                >
                  <DynamicLink href="/[lang]/docs/get-started" prefetch={false}>
                    Get started
                  </DynamicLink>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="hero-glass-button text-white shadow-none hover:text-white"
                >
                  <DynamicLink href="/[lang]/examples" prefetch={false}>
                    Explore examples
                  </DynamicLink>
                </Button>
              </div>
            </div>

            <div className="pointer-events-none relative col-start-1 row-start-1 aspect-square w-[min(70vw,18rem)] justify-self-center min-[768px]:absolute min-[768px]:inset-0 min-[768px]:aspect-auto min-[768px]:w-auto min-[768px]:p-20 min-[1100px]:static min-[1100px]:col-start-2 min-[1100px]:row-start-1 min-[1100px]:size-full min-[1100px]:min-h-0">
              <div
                data-triangle-container
                aria-hidden="true"
                className="size-full"
              />
            </div>
          </div>
        </div>
      </section>
    </HeroTabProvider>
  );
}
