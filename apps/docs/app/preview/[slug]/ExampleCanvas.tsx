'use client';

import { useEffect, useRef, useState } from 'react';
import { getExampleRunner } from '@/lib/example-runners';

interface ExampleCanvasProps {
  slug: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function ExampleCanvas({ slug }: ExampleCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const runner = getExampleRunner(slug);
    if (!runner) {
      const message = `Unknown example: ${slug}`;
      setError(message);
      window.parent?.postMessage({ type: 'vgpu-example-error', slug, message }, window.location.origin);
      return;
    }

    let disposed = false;
    let dispose: (() => void) | undefined;

    runner(canvas)
      .then((cleanup) => {
        if (disposed) cleanup();
        else dispose = cleanup;
      })
      .catch((err: unknown) => {
        const message = messageOf(err);
        setError(message);
        window.parent?.postMessage({ type: 'vgpu-example-error', slug, message }, window.location.origin);
      });

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [slug]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      {error ? (
        <div className="absolute inset-0 overflow-auto bg-black/90 p-4 font-mono text-xs leading-5 text-red-200">
          <div className="mb-2 font-sans text-sm font-semibold text-red-100">Preview error</div>
          <pre className="whitespace-pre-wrap">{error}</pre>
        </div>
      ) : null}
    </div>
  );
}
