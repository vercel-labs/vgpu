# by-example §13 headless test

Runnable main API (`vgpu`) example for by-example §13 headless test. The Vitest file uses `vgpu/node` so it can run in the Docker GPU harness; browser code is the same except for `init(canvas)` and `gpu.screen`.
