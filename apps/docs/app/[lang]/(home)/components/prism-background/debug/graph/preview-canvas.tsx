import { useEffect, useRef } from "react";

import type { PrismDebugSource } from "../../pipelines/types";
import {
  NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
  type PrismDebugPreviewBridge,
} from "../preview-bridge";

interface PreviewCanvasProps {
  readonly bridge: PrismDebugPreviewBridge;
  readonly source: PrismDebugSource;
}

/** Registers visible canvases imperatively; preview frames never enter React. */
export function PreviewCanvas({ bridge, source }: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let detach: (() => void) | undefined;
    const attach = () => {
      detach ??= bridge.attachPreview({ canvas, source });
    };
    const release = () => {
      detach?.();
      detach = undefined;
    };

    const Observer = canvas.ownerDocument.defaultView?.IntersectionObserver;
    if (!Observer) {
      attach();
      return release;
    }

    const observer = new Observer(
      ([entry]) => (entry?.isIntersecting ? attach() : release()),
      {
        root: canvas.closest<HTMLElement>(".react-flow"),
        rootMargin: "48px",
      }
    );
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      release();
    };
  }, [bridge, source]);

  return (
    <div className="prism-debug-node__preview">
      {bridge === NOOP_PRISM_DEBUG_PREVIEW_BRIDGE ? (
        <span aria-hidden="true">GPU preview pending</span>
      ) : null}
      <canvas
        ref={canvasRef}
        aria-label={`${source.label} preview`}
        height={144}
        width={256}
      />
    </div>
  );
}
