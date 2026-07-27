'use client';

import { useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import type { ExampleRenderer } from '../../lib/example-renderer';
import { Controls } from './controls';
import { createRenderer } from './renderer';
import { DEFAULT_POST_PROCESSING_CONTROLS, type PostProcessingControls } from './types';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ExampleRenderer<PostProcessingControls> | null>(null);
  const [controls, setControls] = useState<PostProcessingControls>(DEFAULT_POST_PROCESSING_CONTROLS);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas, initialControls: controls, onError: reportError });
    rendererRef.current = renderer;
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });
    return () => { rendererRef.current = null; renderer.dispose(); };
    // Initial controls are passed only at mount; subsequent changes use setControls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportError]);

  useEffect(() => rendererRef.current?.setControls?.(controls), [controls]);

  return <div className="relative h-full w-full overflow-hidden bg-black"><canvas ref={canvasRef} className="block h-full w-full touch-none" /><Controls value={controls} onChange={setControls} /></div>;
}
