# Queue

`Queue` wraps `GPUQueue` with the operations core needs: writing buffer data and
waiting for submitted work. `.gpu` exposes the raw queue for callers that need direct
WebGPU control.
