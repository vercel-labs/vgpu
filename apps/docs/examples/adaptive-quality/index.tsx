'use client';

import { useEffect, useRef, useState } from 'react';

import type { QualityPreference, QualityState } from './quality';
import { createRenderer, type Renderer } from './renderer';

const PREFERENCES: readonly QualityPreference[] = ['auto', 'high', 'low'];

const REASON_LABELS: Record<QualityState['reason'], string> = {
  initial: 'default',
  forced: 'forced',
  'gpu-tier': 'GPU tier',
  battery: 'battery',
  'frame-health': 'FPS drops',
};

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [state, setState] = useState<QualityState>({ preference: 'auto', effective: 'high', reason: 'initial' });
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const renderer = createRenderer({ canvas });
    rendererRef.current = renderer;
    const unsubscribe = renderer.subscribe(setState);
    void renderer.ready.then(() => {
      if (cancelled) return;
      setState(renderer.getState());
      setIsReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className={`block h-full w-full touch-none transition-opacity duration-500 ${
          isReady ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 font-mono text-xs text-white/80">
        <div className="rounded-md bg-black/50 px-3 py-2 backdrop-blur">
          <span className="uppercase tracking-wide text-white/50">tier</span>{' '}
          <span className="font-semibold text-white">{state.effective}</span>
          <span className="text-white/50"> · {REASON_LABELS[state.reason]}</span>
        </div>
        <div className="pointer-events-auto flex overflow-hidden rounded-md bg-black/50 backdrop-blur">
          {PREFERENCES.map((preference) => (
            <button
              key={preference}
              type="button"
              onClick={() => void rendererRef.current?.setPreference(preference)}
              className={`px-3 py-2 uppercase tracking-wide transition-colors ${
                state.preference === preference ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'
              }`}
            >
              {preference}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Example;
