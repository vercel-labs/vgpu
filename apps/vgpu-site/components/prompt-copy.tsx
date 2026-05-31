"use client";

import { useId, useState } from "react";

const prompt = "npx vgpu docs";

function CopyIcon() {
  return (
    <svg aria-hidden="true" className="size-tab-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M5 15V7a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" className="size-tab-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function PromptCopy() {
  const [copied, setCopied] = useState(false);
  const statusId = useId();

  async function copyPrompt() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="pointer-events-auto mt-tab-6 flex w-full max-w-[520px] flex-col items-center gap-tab-3 rounded-site border border-border/80 bg-background/55 p-tab-3 text-left backdrop-blur md:flex-row md:justify-between">
      <div className="min-w-0">
        <p className="text-pretty text-[0.875rem] leading-5 text-muted-foreground">Give your agent the VGPU docs first.</p>
        <code className="mt-tab-1 block truncate font-mono text-[0.875rem] text-foreground">{prompt}</code>
      </div>
      <button
        type="button"
        aria-label={copied ? "Copied npx vgpu docs" : "Copy npx vgpu docs"}
        aria-describedby={statusId}
        className="inline-grid size-block-1.5 shrink-0 place-items-center rounded-tab-2 border border-border text-foreground transition hover:border-foreground focus:outline-none focus:ring-2 focus:ring-foreground/40"
        onClick={copyPrompt}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span id={statusId} className="sr-only" aria-live="polite">
        {copied ? "Copied npx vgpu docs to clipboard" : ""}
      </span>
    </div>
  );
}
