"use client";

import { useEffect, useRef, useState } from "react";

const eveVideo = "/examples/eve/eve-hero-1080p.mp4";
const eveVideoPoster = "/examples/eve/eve-billboard.png";

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "00:00";

  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${remainder
    .toString()
    .padStart(2, "0")}`;
}

export function EveVideo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const progress =
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
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
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="flex aspect-video flex-col bg-black">
      <video
        aria-label="Eve shader rendered as video"
        autoPlay={shouldLoad}
        className="min-h-0 w-full flex-1 object-contain"
        loop
        muted
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
          setDuration(event.currentTarget.duration);
        }}
        playsInline
        poster={shouldLoad ? eveVideoPoster : undefined}
        preload="none"
        src={shouldLoad ? eveVideo : undefined}
      />
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-white/10 bg-black px-2.5">
        <span className="block size-1.5 shrink-0 rounded-full bg-white" />
        <span className="relative h-px flex-1 bg-white/20">
          <span
            className="absolute inset-y-0 left-0 bg-white/80"
            style={{ width: `${progress}%` }}
          />
          <span
            className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
            style={{ left: `${progress}%` }}
          />
        </span>
        <span className="font-mono text-[9px] tabular-nums text-white/55">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
