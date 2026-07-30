# ORT `initFromDevice(device)` recipe and E2E

This non-published experiment is the executable Node/browser recipe for vgpu 0.1.6. Its pinned matrix is **Node 22**, **webgpu 0.4.0**, **onnxruntime-web 1.27.0**, and vgpu's software renderer 0.1.6. It does not add dependencies or globals to a shipped vgpu package.

## Node recipe

Install this directory's exact dependencies, build the repository, and run `node/run-e2e.sh`. The user-side setup is in `node/recipe.mjs`: it imports the supported public `webgpu` package, creates one Dawn singleton, installs that singleton as `navigator.gpu`, installs WebGPU constructors and `self`, and only then imports `ort.webgpu.bundle.min.mjs`. Absolute asyncify `.mjs`/`.wasm` paths, `wasmBinary`, and `numThreads=1` are required. The generic threaded WASM flavor is intentionally tested in a separate process and must fail with `webgpuInit is not a function`.

`webgpu@0.4.0`'s Linux ARM64 prebuilt requires glibc 2.38. Run the primary public-package recipe and generic-WASM negative proof on x64 CI or ARM64 with glibc 2.38 or newer. On older ARM64 hosts, `node/run-fallback-e2e.sh` is the explicitly labeled host fallback: it installs and uses the supported `@vgpu/adapter-node` portable Dawn and software renderer 0.1.6, then runs the same positive snapshot/reference, identity, anti-fallback, lifecycle, and native-destroy assertions. It does not replace the primary recipe or its negative proof.

The application adopts `ort.env.webgpu.device` with `initFromDevice(device)`. vgpu does not import ORT, select its assets, or mutate globals.

## Lifetime

Reference mode follows this order in `shared/pipeline.ts` and each runner: retain the GPU Tensor; `wrapBuffer(tensor.gpuBuffer)`; bind and submit; `await gpu.device.queue.flush()`; dispose the wrapper in `finally`; dispose the Tensor in the caller's `finally`. Overall teardown is stop producers, fence, dispose wrappers, `gpu.dispose()`, then `session.release()`.

Snapshot mode uses only the existing raw route: create a vgpu destination with `copy_dst`, encode exactly one `gpu.gpu.createCommandEncoder().copyBufferToBuffer(...)`, submit, then consume the normal vgpu Buffer. No Frame API is implied.

## Browser recipe

Run `browser/run-e2e.sh` on a free port 3004 or higher. It invokes `agent-browser doctor --webgpu --headed`, waits six seconds plus two animation frames, captures DOM, console, screenshot, pixel standard deviation, and fail-closed JSON evidence under `artifacts/`. Never use port 3001 for this harness.
