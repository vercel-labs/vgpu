# by-example §8 ping-pong

Runnable main API (`vgpu`) example for by-example §8 ping-pong. The Vitest file uses `vgpu/node` so it can run in the Docker GPU harness; browser code is the same except for `init() + surface(gpu, canvas)` and `surface`.
