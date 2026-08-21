"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { type HeroTab, useHeroTab } from "@/components/hero/hero-tab-state";
import { InlineCode, stripBackticks } from "./inline-code";

/** `mono` distinguishes terminal commands from the natural-language prompt. */
const tabContent = {
  Prompt: { text: "Setup vgpu on my project, run `npx vgpu`", mono: false },
  CLI: { text: "`pnpm add vgpu`", mono: true },
  Skill: {
    text: "`npx skills add vercel-labs/vgpu`",
    mono: true,
  },
} as const;

type Tab = keyof typeof tabContent;

type HeroTabsTab = Extract<Tab, HeroTab>;

const tabs = Object.keys(tabContent) as HeroTabsTab[];

/**
 * How long the outgoing snippet takes to clear, in ms. The incoming one settles
 * over 200ms (`duration-200` below): the outgoing line leaving a touch faster
 * reads as a handover rather than a dissolve.
 *
 * Keep this in step with the `duration-150` on the leaving layer — it is what
 * decides when that layer is re-parked below the line, and re-parking early
 * would cut the fade short.
 */
const LEAVE_MS = 150;

/**
 * Hero setup snippet: a text-only tab switcher over a hairline rule.
 *
 * Deliberately not a card — it sits directly on the shader, so the only chrome
 * is the divider. Copy is the whole line rather than a button: the icon is just
 * an affordance that fades in on hover, and confirmation is a swap to a check.
 *
 * Ported verbatim (same copy, same interaction) from
 * apps/docs/components/hero-tabs.tsx — this piece is the exact content the
 * user asked to keep unchanged, so it is not rebuilt with template
 * components the way the rest of the landing chrome is (see TGEIST-10).
 */
export function HeroTabs() {
  const { activeTab, setActiveTab } = useHeroTab();
  // The tab that is currently on its way out. Every other inactive tab is
  // "parked" below the line, which is what makes the next one rise from below.
  const [leavingTab, setLeavingTab] = useState<Tab | null>(null);
  const [copied, setCopied] = useState(false);
  const parkTimer = useRef<number | undefined>(undefined);
  const content = tabContent[activeTab].text;

  const selectTab = (tab: Tab) => {
    if (tab === activeTab) return;
    setLeavingTab(activeTab);
    setActiveTab(tab);
    // Re-park the outgoing layer below the line once it has faded, so it rises
    // again on its next turn instead of dropping in from above. It is fully
    // transparent by then, so the jump back down is invisible. Restarting the
    // timer on every switch is also the guard against fast alternating clicks:
    // a layer is only ever re-parked after it has actually finished leaving.
    window.clearTimeout(parkTimer.current);
    parkTimer.current = window.setTimeout(() => setLeavingTab(null), LEAVE_MS);
  };

  useEffect(() => () => window.clearTimeout(parkTimer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stripBackticks(content));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission). The
      // snippet is on screen and selectable, so failing silently is fine.
    }
  };

  return (
    // No `gap` on the column: the rule carries its own asymmetric margins (see
    // below), and a gap would add to both sides equally.
    <div className="flex w-full flex-col">
      <div
        data-hero-tabs-list
        role="tablist"
        aria-label="Setup option"
        className="flex items-center justify-center text-[15px] leading-none lg:text-[16px]"
      >
        {tabs.map((tab, index) => (
          <Fragment key={tab}>
            {index > 0 && (
              <span aria-hidden className="px-2 text-white">
                ·
              </span>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => selectTab(tab)}
              className={
                activeTab === tab
                  ? "text-white"
                  : "text-white/50 hover:text-white/80"
              }
            >
              {tab}
            </button>
          </Fragment>
        ))}
      </div>

      {/*
        Hairline rule that dissolves at both ends. A hard-edged 1px line reads as
        a UI seam pinned over the shader; fading the ends lets it sit in the
        image instead. Gradient rather than a border since a border can't taper.

        No flat middle on purpose: sampling the rule in the Figma reference gives
        a symmetric triangle (alpha .57/.98/.56 at 25/50/75%), i.e. it peaks at
        #4D4D4D dead centre and ramps straight down to both ends. A solid centre
        band reads noticeably heavier than the reference.
      */}
      {/*
        Asymmetric margins, not a uniform column gap: the rule belongs to the
        snippet below it, so it sits closer to that than to the tabs above.

        The two numbers are not the two visual gaps. The tabs run `leading-none`
        (box hugs the glyphs) while the snippet runs `leading-relaxed` (~5px of
        half-leading above its ink), so an equal margin already reads as a
        bigger gap underneath. mt-5/mb-2 = 20/8px of box spacing lands at
        roughly 25/14px of measured ink-to-ink spacing.
      */}
      <div
        aria-hidden
        className="mb-2 mt-5 h-px w-full bg-[linear-gradient(to_right,transparent,#4D4D4D_10%,transparent)]"
      />

      <button
        data-hero-tabs-copy
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy: ${stripBackticks(content)}`}
        className="group relative w-full px-7 text-center text-[15px] leading-relaxed text-white/90 transition-opacity hover:text-white lg:text-[16px]"
      >
        {/*
          Every snippet is rendered, stacked in one grid cell, and crossfaded.

          Stacking rather than swapping a single node is what keeps the block
          rigid: the cell is always as tall as the LONGEST snippet, so neither
          the rule above nor the tagline this is centred with can move — not
          during the transition, and not between tabs with different content
          lengths.

          Three states instead of active/inactive, because direction matters:
          the one leaving lifts UP and the one arriving rises from BELOW, so a
          tab that is merely idle has to wait below the line. Plain transitions
          (no keyframes) so an interrupted switch interpolates from wherever it
          got to instead of snapping back to 0% — mash the tabs and it stays
          smooth.
        */}
        <span className="grid">
          {tabs.map((tab) => {
            const state =
              tab === activeTab
                ? "active"
                : tab === leavingTab
                ? "leaving"
                : "idle";
            return (
              <span
                key={tab}
                aria-hidden={state !== "active"}
                // motion-reduce drops the transition only: the same end states
                // still apply, so the swap is instant instead of animated.
                className={`col-start-1 row-start-1 motion-reduce:transition-none ${
                  state === "active"
                    ? "translate-y-0 opacity-100 transition duration-200 ease-out"
                    : state === "leaving"
                    ? "-translate-y-1.5 select-none opacity-0 transition duration-150 ease-out"
                    : // Parked below with no transition, so re-parking after a
                      // switch costs nothing and is invisible at opacity 0.
                      "translate-y-1.5 select-none opacity-0"
                }`}
              >
                <InlineCode
                  text={tabContent[tab].text}
                  mono={tabContent[tab].mono}
                />
              </span>
            );
          })}
        </span>
        <span
          aria-hidden
          className={`absolute right-0 top-1/2 -translate-y-1/2 transition-opacity ${
            copied ? "opacity-90" : "opacity-0 group-hover:opacity-50"
          }`}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
    </div>
  );
}
