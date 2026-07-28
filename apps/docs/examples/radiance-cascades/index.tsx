'use client';

import { useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { Controls } from './controls';
import { createRenderer, type RadianceCascadesRenderer } from './renderer';
import { DEFAULT_RADIANCE_CASCADES_CONTROLS, type RadianceCascadesControls } from './types';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RadianceCascadesRenderer | null>(null);
  const [controls, setControls] = useState<RadianceCascadesControls>(DEFAULT_RADIANCE_CASCADES_CONTROLS);
  const [cascadeCount, setCascadeCount] = useState(6);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({
      canvas,
      initialControls: DEFAULT_RADIANCE_CASCADES_CONTROLS,
      onError: reportError,
      onCascadeCount: setCascadeCount,
    });
    rendererRef.current = renderer;
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });
    return () => { rendererRef.current = null; renderer.dispose(); };
  }, [reportError]);

  useEffect(() => rendererRef.current?.setControls?.(controls), [controls]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      <Controls
        value={controls}
        onChange={setControls}
        onClear={() => rendererRef.current?.clear()}
        cascadeCount={cascadeCount}
      />
      <div className="pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-xs font-medium uppercase tracking-[.08em] text-white/80">
        draw light
      </div>
    </div>
  );
}
