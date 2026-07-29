---
"vgpu": patch
---

Stop the render loops a gpu created when it is disposed: `frame.loop(cb)` handles are tracked like the timers and visibilities `gpu.dispose()` already releases, so disposal cancels the scheduled tick and the callback stops running against a disposed device (a loop that was stopped by hand drops its registration first). Internal tidy-ups with no behavior change: telemetry instances now expose an explicit `frameAbandoned(frame)` hook for frames that never reach the queue — a failed pass, a failed finish/submit, a cancelled frame — instead of the implicit `finalizeFrame(ABANDONED_FRAME)` + `frameSubmitted` pairing, and the `VGPU-QUERY-READBACK` error moved from an inline construction in the query ring to a `queryReadbackError()` factory in `errors.ts` like every other vgpu error.
