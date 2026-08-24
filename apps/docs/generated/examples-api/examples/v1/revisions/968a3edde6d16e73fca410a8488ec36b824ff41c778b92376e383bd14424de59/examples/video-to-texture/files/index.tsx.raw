'use client';

import { useEffect, useRef, useState } from 'react';

import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { createRenderer, type VideoStatus } from './renderer';

/**
 * The readout is the point of the example as much as the cube is: `uploads` counts
 * texture copies and `rendered` counts drawn frames. On a 120 Hz display showing a
 * 24 fps clip the second number climbs about five times faster than the first,
 * which is exactly the redundancy `requestVideoFrameCallback` removes.
 */
export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<VideoStatus>({ phase: 'loading', uploads: 0, rendered: 0 });

  useEffect(() => {
    if (!canvasRef.current) return;
    const pending = createRenderer(canvasRef.current, {
      onStatus: setStatus,
    }).catch((error: unknown) => {
      reportError(error);
      return undefined;
    });

    return () => {
      void pending.then((renderer) => renderer?.dispose());
    };
  }, [reportError]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      <div className="pointer-events-none absolute left-3 top-3 font-mono text-[11px] leading-5 text-white/70">
        {status.phase === 'playing' ? (
          <>
            <div>
              {status.frame?.precise
                ? 'requestVideoFrameCallback'
                : 'requestAnimationFrame fallback'}
            </div>
            <div>
              {`uploads ${status.uploads} · frames drawn ${status.rendered}`}
            </div>
            <div>{`media time ${(status.frame?.mediaTime ?? 0).toFixed(2)}s`}</div>
          </>
        ) : (
          <div>{status.phase === 'failed' ? 'video unavailable' : 'loading video…'}</div>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 font-mono text-[10px] text-white/50">
        {'Big Buck Bunny © Blender Foundation · CC BY 3.0'}
      </div>
    </div>
  );
}
