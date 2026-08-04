"use client";

import { useEffect, useState } from "react";

// TGEIST-09: verbatim behaviour of the old app's `ExamplePreview` (embeds the
// `/preview/<slug>` route -- owned by TGEIST-08 -- in an iframe and surfaces
// `postMessage`-reported render errors), only the chrome around it changed.
interface ExamplePreviewProps {
  slug: string;
  title: string;
}

interface PreviewErrorMessage {
  type: "vgpu-example-error";
  slug: string;
  message: string;
}

function isPreviewErrorMessage(value: unknown): value is PreviewErrorMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PreviewErrorMessage).type === "vgpu-example-error" &&
    typeof (value as PreviewErrorMessage).slug === "string" &&
    typeof (value as PreviewErrorMessage).message === "string"
  );
}

export function ExamplePreview({ slug, title }: ExamplePreviewProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [slug]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!isPreviewErrorMessage(event.data)) return;
      if (event.data.slug !== slug) return;
      setError(event.data.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slug]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black shadow-2xl">
      <iframe
        allow="fullscreen"
        className="h-full w-full border-0 bg-black"
        src={`/preview/${slug}`}
        title={`${title} preview`}
      />
      {error ? (
        <div className="absolute inset-0 overflow-auto bg-black/85 p-5 text-sm text-red-300 backdrop-blur-sm">
          <div className="mb-3 font-semibold text-red-200">Preview error</div>
          <pre className="whitespace-pre-wrap rounded-md border border-red-800/40 bg-red-950/40 p-3 font-mono text-xs leading-5">
            {error}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
