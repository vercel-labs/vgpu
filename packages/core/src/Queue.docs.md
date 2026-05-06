# Queue

`Queue` wraps `GPUQueue` with the S1 operations core needs: writing buffer data and
waiting for submitted work. `.gpu` exposes the raw queue for callers that need direct
WebGPU control.
