"use client";

import { useEffect, useRef, useState } from "react";

import { type CameraNotice } from "./camera-source";
import { createRenderer } from "./renderer";

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [notice, setNotice] = useState<CameraNotice | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas, onCameraNotice: setNotice });
    void renderer.ready;
    return () => renderer.dispose();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black p-4">
      <canvas
        ref={canvasRef}
        aria-label="Mirrored camera view behind frosted glass, wiped clear by either hand"
        className="block h-full w-full rounded-lg border border-gray-4 bg-gray-1"
      />
      {notice ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-4 bottom-4 mx-auto max-w-md rounded-lg border border-gray-4 bg-gray-1/95 p-4 text-sm text-gray-11"
        >
          <p className="mb-1 font-medium text-gray-12">{notice.message}</p>
          <p className="text-gray-9">{notice.hint}</p>
        </div>
      ) : null}
    </div>
  );
}
