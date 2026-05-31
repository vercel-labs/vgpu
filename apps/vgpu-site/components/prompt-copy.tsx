"use client";

import { Check, Copy } from "lucide-react";
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
    <div className="pointer-events-auto mt-6 flex w-full max-w-[500px] items-center justify-between gap-3 rounded-2xl border border-border-strong bg-background/60 p-3 text-left shadow-xl shadow-black/25 backdrop-blur">
      <div className="min-w-0 px-1">
        <p className="text-pretty text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Give your agent the VGPU docs first.</p>
        <code className="mt-1 block truncate font-mono text-sm text-foreground">{prompt}</code>
      </div>
      <button
        type="button"
        aria-label={copied ? "Copied npx vgpu docs" : "Copy npx vgpu docs"}
        aria-describedby={statusId}
        className="grid size-9 shrink-0 place-items-center rounded-full text-foreground/75 transition hover:bg-white/[0.06] hover:text-foreground focus:outline-none focus:ring-2 focus:ring-foreground/30"
        onClick={copyPrompt}
      >
        {copied ? <Check className="size-4" strokeWidth={2} aria-hidden="true" /> : <Copy className="size-4" strokeWidth={1.8} aria-hidden="true" />}
      </button>
      <span id={statusId} className="sr-only" aria-live="polite">
        {copied ? "Copied npx vgpu docs to clipboard" : ""}
      </span>
    </div>
  );
}
