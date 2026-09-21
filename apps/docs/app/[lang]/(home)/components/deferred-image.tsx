"use client";

import Image, { type ImageProps } from "next/image";
import { useEffect, useRef, useState } from "react";

/**
 * Keeps below-the-fold image URLs out of the initial document fetch queue.
 * Native lazy loading intentionally has a generous look-ahead window, which
 * is too early while the WebGPU hero is still initializing.
 */
export function DeferredImage(props: ImageProps) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "256px 0px" }
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);

  return (
    <span ref={markerRef} className="absolute inset-0 block">
      {shouldLoad ? <Image {...props} /> : null}
    </span>
  );
}
