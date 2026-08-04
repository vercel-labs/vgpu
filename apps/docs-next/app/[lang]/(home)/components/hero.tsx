import { HeroBlackHole } from '@/components/hero/hero-black-hole';
import { HeroTabs } from './hero-tabs';

/**
 * Landing hero.
 *
 * The shader (`components/hero/**`, transplanted verbatim — see TGEIST-10) is
 * the full section; the copy sits on top of it. Structure, overlays and
 * copy are ported unchanged from `apps/docs/app/page.tsx`'s hero section — this
 * is the piece the design decision calls out as "not a design asset", so it is
 * not rebuilt with template chrome the way the sections below it are.
 */
export function Hero() {
  return (
    <section className="relative min-h-svh overflow-hidden bg-black">
      <HeroBlackHole />

      {/* Legibility scrim. Matches the Figma ellipse: a band centred on the
          hero, opaque black through the core and fully transparent at the
          edges, so the disk still burns through at the left and right. */}
      <div
        data-hero-overlay
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 z-[1] h-[62%] -translate-y-1/2"
        style={{
          background:
            'radial-gradient(ellipse 50% 50% at 50% 50%, #000 31%, rgba(0,0,0,0) 60%)',
        }}
      />

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
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[16%]"
        style={{
          background:
            'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.52) 24%, rgba(0,0,0,0.3) 48%, rgba(0,0,0,0.13) 72%, rgba(0,0,0,0) 100%)',
        }}
      />

      {/* Tagline + setup snippet, one block centred on the hero — it sits
          inside the shadow.

          The band is pointer-events-none so it never eats clicks over the
          rest of the hero, but the children opt back IN: without that the
          tagline cannot be selected and the tabs cannot be clicked, because
          pointer-events is inherited. */}
      <div
        data-hero-overlay
        className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-10 px-6 lg:gap-12"
      >
        <h1
          className="pointer-events-auto max-w-[798px] text-center font-light leading-[1.25] text-white"
          /* Sized off the viewport HEIGHT, not the width: the tagline has
             to stay inside the black hole's shadow, and the shadow is a
             circle scaled by the shorter axis. 2.4svh = 21.6px at 900px
             tall. The clamp floor keeps it readable on short landscape
             phones and the ceiling stops it ballooning on tall monitors. */
          style={{ fontSize: 'clamp(1rem, 4svh, 10.75rem)' }}
        >
          The WebGPU library,
          {/* Forces the two-line break of the design on wide viewports; on
              narrow ones it collapses and the line wraps on its own. */}
          <br className="hidden sm:block" /> designed for agents.
        </h1>

        {/* Setup snippet, reading as one unit with the tagline above it.
            Part of the centred flex column rather than pinned to the foot
            of the hero, so the pair stays together and stays inside the
            shadow at any viewport height. */}
        <div className="pointer-events-auto w-[450px] max-w-full">
          <HeroTabs />
        </div>
      </div>
    </section>
  );
}
