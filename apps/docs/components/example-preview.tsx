'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

interface ExamplePreviewProps {
  slug: string;
  title: string;
  poster?: string;
}

interface PreviewErrorMessage {
  type: 'vgpu-example-error';
  slug: string;
  message: string;
}

function isPreviewErrorMessage(value: unknown): value is PreviewErrorMessage {
  return typeof value === 'object'
    && value !== null
    && (value as PreviewErrorMessage).type === 'vgpu-example-error'
    && typeof (value as PreviewErrorMessage).slug === 'string'
    && typeof (value as PreviewErrorMessage).message === 'string';
}

export function ExamplePreview({ slug, title, poster }: ExamplePreviewProps) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setError(null);
    setLoaded(false);
  }, [slug]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!isPreviewErrorMessage(event.data)) return;
      if (event.data.slug !== slug) return;
      setError(event.data.message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [slug]);

  return (
    <div className="relative h-[60vh] min-h-[420px] overflow-hidden rounded-lg border border-gray-4 bg-black shadow-2xl">
      <iframe
        title={`${title} preview`}
        src={`/preview/${slug}`}
        className="h-full w-full border-0 bg-black"
        allow="fullscreen"
        onLoad={() => setLoaded(true)}
      />
      {poster && !loaded ? (
        <Image
          src={poster}
          alt={`${title} poster`}
          fill
          priority
          sizes="(max-width: 1280px) 100vw, 900px"
          className="object-cover"
        />
      ) : null}
      {error ? (
        <div className="absolute inset-0 overflow-auto bg-black/85 p-5 text-sm text-red-200 backdrop-blur-sm">
          <div className="mb-3 font-semibold text-red-100">Preview error</div>
          <pre className="whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-950/40 p-3 font-mono text-xs leading-5">
            {error}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
