# Display-free Vulkan adapter test

Runs the adapter-node native readback suite, including a 64x64 gradient render,
on Node 24 with Mesa lavapipe and no X11/Wayland display.

```sh
VGPU_DAWN_BINARY=/path/to/dawn.node infra/test-docker-vulkan/run.sh
```
