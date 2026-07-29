/**
 * Per-frame clock, as a lazy kernel service.
 *
 * This is the small "frame state" the core deliberately does not carry as public fields:
 * a program that never opens a frame never creates it. Registered through a token so the
 * kernel keeps no static reference to it. The public face of this service is `clock(gpu)`.
 */
import { serviceToken, type Kernel } from "./kernel.ts";
import { frameReentrantError } from "./errors.ts";

export interface FrameState {
  /** Seconds since the first frame. */
  time: number;
  /** Seconds between the last two ticks. */
  deltaTime: number;
  frameCount: number;
  /**
   * Advances the clock by `dtSeconds` right now and claims this frame's tick: the next `tick()`
   * counts the frame and runs the hooks, but does not move the clock again.
   */
  advanceBy(dtSeconds: number): void;
  /**
   * Counts one frame and runs the registered per-frame hooks, advancing the clock with wall-clock
   * time unless `advanceBy()` already advanced it since the last tick. Throws `VGPU-FRAME-REENTRANT`
   * if re-entered.
   */
  tick(): void;
  /** Runs right after the clock advances, before the frame callback (surface auto-resize lives here). */
  onAdvance(hook: () => void): () => void;
}

export const frameStateToken = serviceToken<FrameState>("frame-state");

/** Lazily creates the frame state of this kernel; repeated calls return the same instance. */
export function frameState(kernel: Kernel): FrameState {
  return kernel.service(frameStateToken, createFrameState);
}

function createFrameState(): FrameState {
  const hooks = new Set<() => void>();
  let lastTimeMs = nowMs();
  let ticking = false;
  // True while a manual advance() owns this frame's tick: one advance per frame, manual wins.
  let manualPending = false;
  const state: FrameState = {
    time: 0,
    deltaTime: 0,
    frameCount: 0,
    advanceBy(dtSeconds: number): void {
      state.deltaTime = dtSeconds;
      state.time += dtSeconds;
      manualPending = true;
    },
    tick(): void {
      if (ticking) throw frameReentrantError();
      ticking = true;
      try {
        const next = nowMs();
        if (manualPending) {
          // The clock already moved this frame; only re-base the wall clock so the next
          // auto-advanced frame measures from this tick, not from the last automatic one.
          manualPending = false;
        } else {
          state.deltaTime = Math.max(0, (next - lastTimeMs) / 1000);
          state.time += state.deltaTime;
        }
        lastTimeMs = next;
        state.frameCount += 1;
        for (const hook of [...hooks]) hook();
      } finally {
        ticking = false;
      }
    },
    onAdvance(hook: () => void): () => void {
      hooks.add(hook);
      return () => { hooks.delete(hook); };
    },
  };
  return state;
}

function nowMs(): number { return globalThis.performance?.now?.() ?? Date.now(); }
