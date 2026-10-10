---
"vgpu": minor
"@vgpu/core": patch
---

## Summary

`Gpu` now exposes `readonly lost: Promise<GPUDeviceLostInfo>`, a loss-only notification. The promise keeps one identity, never rejects, and resolves once with the native `GPUDeviceLostInfo` when vgpu observes native device loss while the gpu is active. vgpu stops every running `frameLoop` before `gpu.lost` handlers run, so no tick runs or throws after vgpu observes the loss. Loss does not dispose the gpu, destroy its resources, deliver anything to `gpu.onError`, or recover the device: create a new `Gpu` with `init()`, recreate its resources, and restart the loop.

`gpu.dispose()` remains your own teardown, not a loss. Disposing before vgpu observes a loss leaves `gpu.lost` pending; disposing after keeps its resolved value; disposing a gpu from `initFromDevice(device)` still never destroys the borrowed device. A borrowed device destroyed by its owner while the wrapper is active counts as a loss, with `reason: "destroyed"`. `gpu.settled()` never waits for `gpu.lost`.

After an observed loss, every factory, `clock(gpu)`, `frame(gpu)`, and `frameLoop(gpu, cb)` throw `VGPU-DEVICE-LOST` at the call, before the frame clock advances or surface auto-resize runs. A manual `frame(gpu)` that was open at the time is not canceled: its `submit()` still throws `VGPU-DEVICE-LOST` until `gpu.dispose()` cancels it. The `VGPU-DEVICE-LOST` error raised by `@vgpu/core` now carries the fix "Create a new Gpu with init(), then recreate its resources and restart the loop."

The implicit submit of `frame(gpu, cb)` and `frameLoop` ticks no longer swallows `VGPU-DEVICE-LOST` or `VGPU-DEVICE-DISPOSED`: any error it throws now escapes the call, and a loop tick that fails this way stops the loop and rethrows. Calling `gpu.dispose()` inside a callback still cancels the open frame, so its implicit submit stays a no-op.

## Migration

### Affected usage

- Code that detected device loss from the uncaught `VGPU-DEVICE-LOST` that the next `frameLoop` tick used to throw from its animation-frame callback, for example through a global `error` handler. Loops now stop without throwing, so that error no longer appears.
- Code that calls `frameLoop(gpu, cb)` on a gpu whose loss vgpu already observed. The call used to return a handle whose first tick threw; it now throws `VGPU-DEVICE-LOST` synchronously at the call. Factories and `clock(gpu)` on that gpu also throw `VGPU-DEVICE-LOST` at the call.
- `frame(gpu, cb)` or `frameLoop` callbacks that dispose the core device directly with `gpu.device.dispose()` or `gpu.device.destroy()`. The implicit submit used to swallow the resulting `VGPU-DEVICE-DISPOSED`; it now throws it, and a loop tick stops and rethrows it.

Code that tears down with `gpu.dispose()` — including from inside a frame callback — and code that handles `VGPU-DEVICE-LOST` from an explicit `frame.submit()` needs no change.

### Steps

1. Detect loss with `gpu.lost` instead of an uncaught frame-loop error. In the handler, dispose the lost gpu, create a new one with `init()`, recreate its resources, and restart the loop. `gpu.lost` cannot reject, but your recovery code can, so end the chain with `.catch()`:

   ```ts illustrative
   void gpu.lost
     .then(() => {
       gpu.dispose(); // the loops already stopped
       return start(); // init(), recreate resources, restart the loop
     })
     .catch((error: unknown) => console.error("GPU restart failed", error));
   ```

2. Stop creating loops or resources on a gpu after its loss: restart on the new gpu from step 1, or catch `VGPU-DEVICE-LOST` at the call.
3. Inside frame callbacks, replace `gpu.device.dispose()` / `gpu.device.destroy()` with `gpu.dispose()`, which cancels the open frame and stops the loop.

Keep normal unmount unchanged: stop the loop, `await gpu.settled()` when you need submitted work and deliveries to finish, then call `gpu.dispose()`. Do not `await gpu.lost` for teardown; it stays pending for a healthy device and after `gpu.dispose()`.

### Verification

- With a gpu from `initFromDevice(device)` and a running `frameLoop`, call `device.destroy()`: `gpu.lost` resolves with `reason: "destroyed"`, the loop callback stops ticking without an uncaught error, `gpu.disposed` is `false`, and `frame(gpu)` throws `VGPU-DEVICE-LOST`.
- Confirm the recovery handler renders again on the new gpu and that `gpu.onError` received nothing for the loss itself.
- Confirm `gpu.dispose()` from inside a frame callback still produces no error, and that normal unmount completes without awaiting `gpu.lost`.
