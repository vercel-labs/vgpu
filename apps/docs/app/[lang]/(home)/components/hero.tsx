import { HeroTabProvider } from "@/components/hero/hero-tab-state";
import { Button } from "@/components/ui/button";
import { VgpuWordmarkGlyphs } from "@/components/vgpu-wordmark";
import DynamicLink from "fumadocs-core/dynamic-link";
import { HeroTabs } from "./hero-tabs";
import { PrismBackground } from "./prism-background/prism-background";
import "../hero-glass-button.css";
import "../hero-glass-wordmark.css";
import "../hero-light-invert.css";

/**
 * Landing hero.
 *
 * The prism scene is a client-owned WebGPU background. The rest of the hero
 * stays server-rendered and layered above it.
 */
export function Hero() {
  return (
    <HeroTabProvider>
      <section
        data-hero-invert
        className="relative min-h-[calc(100svh-4rem)] overflow-hidden bg-black"
      >
        <PrismBackground />

        {/* Foot fade. This was a tall, near-opaque band back when the setup
          snippet was pinned to the bottom and needed contrast; the snippet
          now sits centred with the tagline, so that job is gone and the band
          was only costing us the lower crescent. What remains is the other
          job it was doing: the hero ends mid-starfield, and cutting straight
          to the black page below leaves a visible seam. Short and gentle is
          enough to hide it.

          Multi-stop rather than a plain two-stop fade: alpha interpolates
          linearly while perceived luminance does not, so `black -> transparent`
          leaves a visible ledge around its midpoint. These stops approximate
          an ease-out curve, which reads as haze instead of a band. */}
        <div
          data-hero-overlay
          data-hero-foot-fade
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[16%]"
          style={{
            background:
              "linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.52) 24%, rgba(0,0,0,0.3) 48%, rgba(0,0,0,0.13) 72%, rgba(0,0,0,0) 100%)",
          }}
        />

        {/* The copy and setup snippet sit on opposite sides of the prism on
          wide screens, and return to one stack on smaller screens.

          The band is pointer-events-none so it never eats clicks over the
          rest of the hero, but the children opt back IN: without that the
          tagline cannot be selected and the tabs cannot be clicked, because
          pointer-events is inherited. */}
        <div
          data-hero-overlay
          className="pointer-events-none absolute inset-x-0 top-1/2 z-10 mx-auto grid w-full max-w-[1448px] -translate-y-1/2 grid-cols-1 items-center justify-items-center gap-10 px-6 min-[768px]:justify-items-start min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)_minmax(0,1fr)] min-[1100px]:gap-8"
        >
          <div className="pointer-events-auto flex flex-col items-center min-[768px]:items-start min-[1100px]:col-start-1 min-[1100px]:row-start-1 min-[1100px]:justify-self-start">
            <h1
              aria-label="vgpu"
              data-hero-title
              className="relative mb-[1em] aspect-[188/75] w-[200px] [--wordmark-fill-blur:3px] [--wordmark-outline-blur:20px]"
            >
              <svg
                aria-hidden="true"
                className="absolute size-0"
              >
                <defs>
                  <filter
                    id="hero-wordmark-inner-bezel"
                    x="-20%"
                    y="-35%"
                    width="140%"
                    height="170%"
                    colorInterpolationFilters="sRGB"
                  >
                    <feTurbulence
                      type="fractalNoise"
                      baseFrequency="0.009 0.035"
                      numOctaves="1"
                      seed="5"
                      result="bezel-map"
                    />
                    <feGaussianBlur
                      in="bezel-map"
                      stdDeviation="0.2"
                      result="soft-bezel-map"
                    />
                    <feDisplacementMap
                      in="SourceGraphic"
                      in2="soft-bezel-map"
                      scale="38"
                      xChannelSelector="R"
                      yChannelSelector="G"
                    />
                  </filter>
                  <mask
                    id="hero-wordmark-fill-mask"
                    maskUnits="objectBoundingBox"
                    maskContentUnits="objectBoundingBox"
                    x="0"
                    y="0"
                    width="1"
                    height="1"
                    style={{ maskType: "luminance" }}
                  >
                    <g
                      fill="white"
                      transform="scale(0.005319148936 0.013333333333)"
                    >
                      <VgpuWordmarkGlyphs />
                    </g>
                  </mask>
                  <mask
                    id="hero-wordmark-outline-mask"
                    maskUnits="objectBoundingBox"
                    maskContentUnits="objectBoundingBox"
                    x="0"
                    y="0"
                    width="1"
                    height="1"
                    style={{ maskType: "luminance" }}
                  >
                    <g
                      fill="none"
                      stroke="white"
                      strokeWidth="1"
                      transform="scale(0.005319148936 0.013333333333)"
                    >
                      <VgpuWordmarkGlyphs />
                    </g>
                  </mask>
                </defs>
              </svg>
              <span
                aria-hidden="true"
                className="hero-glass-wordmark-fill"
              />
              <span
                aria-hidden="true"
                className="hero-glass-wordmark-outline-backdrop"
              />
              <svg
                aria-hidden="true"
                className="hero-glass-wordmark-outline"
                viewBox="0 0 188 75"
              >
                <defs>
                  <linearGradient
                    id="hero-wordmark-outline-light"
                    gradientUnits="userSpaceOnUse"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="75"
                  >
                    <stop offset="0" stopColor="white" stopOpacity="1" />
                    <stop offset="1" stopColor="white" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient
                    id="hero-wordmark-surface-tint"
                    gradientUnits="userSpaceOnUse"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="75"
                  >
                    <stop offset="0" stopColor="white" stopOpacity="0.1" />
                    <stop offset="0.55" stopColor="white" stopOpacity="0.025" />
                    <stop offset="1" stopColor="white" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <g
                  fill="url(#hero-wordmark-surface-tint)"
                  stroke="url(#hero-wordmark-outline-light)"
                  strokeWidth="1."
                >
                  <VgpuWordmarkGlyphs />
                </g>
              </svg>
            </h1>
            <p
              className="max-w-[10em] text-balance text-center font-light leading-tight text-white min-[768px]:text-left"
              style={{ fontSize: "clamp(1rem, 4svh, 10.75rem)" }}
            >
              The WebGPU library, designed for agents.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 min-[768px]:justify-start">
              <Button
                asChild
                size="lg"
                className="bg-white text-black hover:bg-white/90"
              >
                <DynamicLink href="/[lang]/docs/get-started">
                  Get started
                </DynamicLink>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="hero-glass-button text-white shadow-none hover:text-white"
              >
                <DynamicLink href="/[lang]/examples">
                  Explore examples
                </DynamicLink>
              </Button>
            </div>
          </div>

          <div className="pointer-events-auto w-full max-w-[21em] min-[1100px]:col-start-3 min-[1100px]:row-start-1 min-[1100px]:justify-self-end">
            <HeroTabs />
          </div>
        </div>
      </section>
    </HeroTabProvider>
  );
}
