"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

// TGEIST-09c: ported verbatim (behavior + markup) from
// `apps/docs/components/copy-button.tsx`, the old code-viewer's copy
// button, restyled with the ported `gray-*` tokens instead of hardcoded hex.
interface CopyButtonProps {
  code: string;
}

export function CopyButton({ code }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      aria-label={copied ? "Copied!" : "Copy code"}
      className="rounded-md p-1.5 text-gray-9 transition-colors hover:bg-gray-4 hover:text-gray-12"
      onClick={handleCopy}
      type="button"
    >
      {copied ? <Check className="size-4 text-green-9" /> : <Copy className="size-4" />}
    </button>
  );
}
