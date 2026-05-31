"use client";

import { useId, useState } from "react";

const prompt = "npx vgpu docs";

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
    <div className="mt-tab-6 flex w-full max-w-[520px] flex-col items-center gap-tab-3 rounded-site border border-border/80 bg-background/55 p-tab-3 text-left backdrop-blur md:flex-row md:justify-between">
      <div className="min-w-0">
        <p className="text-pretty text-[0.75rem] leading-5 text-muted-foreground">Give your agent the VGPU docs first.</p>
        <code className="mt-tab-1 block truncate font-mono text-[0.8125rem] text-foreground">{prompt}</code>
      </div>
      <button
        type="button"
        aria-describedby={statusId}
        className="inline-flex h-9 shrink-0 items-center rounded-tab-2 border border-border px-tab-3 text-[0.75rem] font-medium text-foreground transition hover:border-foreground focus:outline-none focus:ring-2 focus:ring-foreground/40"
        onClick={copyPrompt}
      >
        {copied ? "Copied" : "Copy prompt"}
      </button>
      <span id={statusId} className="sr-only" aria-live="polite">
        {copied ? "Copied npx vgpu docs to clipboard" : ""}
      </span>
    </div>
  );
}
