'use client';

import { useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { Controls } from './controls';
import { createRenderer, type AgentRadianceRenderer } from './renderer';
import { DEFAULT_AGENT_RADIANCE_CONTROLS, type AgentRadianceControls } from './types';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<AgentRadianceRenderer | null>(null);
  const [controls, setControls] = useState<AgentRadianceControls>(DEFAULT_AGENT_RADIANCE_CONTROLS);
  const [cascadeCount, setCascadeCount] = useState(6);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({
      canvas,
      initialControls: DEFAULT_AGENT_RADIANCE_CONTROLS,
      onError: reportError,
      onCascadeCount: setCascadeCount,
    });
    rendererRef.current = renderer;
    void renderer.ready.catch(() => { /* onError reports initialization failures */ });
    return () => { rendererRef.current = null; renderer.dispose(); };
  }, [reportError]);

  useEffect(() => rendererRef.current?.setControls?.(controls), [controls]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <Controls value={controls} cascadeCount={cascadeCount} onChange={setControls} />
      <div className="pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-[10px] font-medium uppercase tracking-[.16em] text-white/45">
        radiance cascade loading field
      </div>
    </div>
  );
}
