---
"vgpu": minor
---

## Summary

Reject async and thenable `frame` / `frameLoop` callbacks before their frame is implicitly submitted. Inferred Promise and PromiseLike returns are rejected by the public types, while runtime checks protect JavaScript and callbacks whose return type was erased.

## Migration

### Affected usage

Update callbacks passed to `frame`, `frameLoop`, or the equivalent `FrameRunner` methods when they are `async`, return a Promise/PromiseLike, or have a union return type containing one. Also update forwarding helpers whose callback return remains an unresolved generic type: the frame API cannot prove that generic return is synchronous. Callbacks already typed as `void`, `unknown`, or `any` can still compile because those erased types supply no static proof, but now fail at runtime if their actual result is thenable. Synchronous helpers with a concrete non-Promise return need no rewrite.

### Steps

Await asynchronous preparation before calling `frame` or registering `frameLoop`, then keep all frame encoding synchronous. Move asynchronous teardown outside the callback. For a forwarding helper that intentionally accepts frame callbacks without using their return value, type its callback parameter as `FrameLoopCallback` or `(frame: Frame) => void` and pass that callback directly to the frame API; this keeps the runtime thenable defense active. Do not use that erased type, a cast, or a return-type-erasing wrapper to conceal frame-touching async continuations: the frame is canceled when the thenable is detected, so later encoding through that frame fails with `VGPU-FRAME-CANCELED`.

Work explicitly submitted before an invalid callback result remains submitted, and CPU-side async continuation effects are not rolled back.

### Verification

Typecheck the affected calls and confirm Promise/PromiseLike callback returns and unresolved generic forwarding are rejected, while an explicitly void-returning forwarding contract compiles. For runtime-erased cases, confirm `VGPU-ASYNC-FRAME-CALLBACK`, zero implicit submissions for the canceled frame, and one stopped tick for an offending loop callback.
