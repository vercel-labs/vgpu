# C4 WebGPU compute-storage oracle

This is the TypeScript reference for C4. It runs through the public `vgpu/node` API on a real
Dawn WebGPU device: no mock adapter, direct `GPUDevice`, or queue instrumentation participates in
the result.

Run it from the repository root:

```sh
bash experiments/native-metal-spikes/c4-compute-storage/oracle/run.sh
```

The gate builds the public package entry point, type-checks the oracle, reads the same canonical
`../fixtures/compute-storage.wgsl` file as the C1 native gate, executes it twice, rejects stderr,
compares both outputs byte-for-byte, and compares stdout with `expected.json`. On macOS, the stock
`webgpu` package provides a Dawn Metal binary, so the gate runs locally. The existing Linux Lane C
environment can run the same script after starting Xvfb and setting `VGPU_DOCKER_TEST=1`; for
example, inside its prepared container:

```sh
Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
VGPU_DOCKER_TEST=1 bash experiments/native-metal-spikes/c4-compute-storage/oracle/run.sh
```

## Fixture contract

One WGSL module declares five runtime-sized `array<u32>` resources:

| Binding | Name           | Access     | `advance` | `mix` |
| ------: | -------------- | ---------- | :-------: | :---: |
|       0 | `src`          | read       |    yes    |  yes  |
|       1 | `mask`         | read       |    yes    |  yes  |
|       2 | `dst`          | read-write |    yes    |  yes  |
|       3 | `advanceAudit` | read-write |    yes    |  no   |
|       4 | `mixAudit`     | read-write |    no     |  yes  |

Both `src` and `mask` deliberately bind the same current read half. This proves read/read aliasing
is valid while keeping the writable destination on the other half.

- `advance` uses `@workgroup_size(2, 1, 1)` and dispatches `(2, 1, 2)`. It flattens with
  `id.x + id.z * (num_workgroups.x * 2)` and applies
  `dst = src * 2 + (mask - src) + 1`. Its audit is `[101, 2, 1, 2]`.
- After an explicit swap and binding update, `mix` uses `@workgroup_size(1, 2, 1)` and dispatches
  `(2, 2, 1)`. It flattens with `id.y * num_workgroups.x + id.x` and applies
  `dst = src * 2 + mask * 2 + 2`. Its audit is `[202, 2, 2, 1]`.
- Starting from `[0, 1, 2, 3, 4, 5, 6, 7]`, the final state is exactly
  `[6, 14, 22, 30, 38, 46, 54, 62]`.
- The roles observed around the two swaps are `A->B`, `B->A`, `A->B`. Both dispatches are submitted
  before the first readback await, so the result exercises queue ordering instead of a CPU wait
  between kernels.
- A final dispatch binds the current read half as `src`, `mask`, and writable `dst`. It must throw
  `VGPU-R1-STORAGE-ALIASING` synchronously. State and an audit sentinel must stay unchanged, and the
  rejection must not reach `gpu.onError`.

The JSON deliberately excludes adapter names and timing data so it stays canonical across Dawn
Metal, Vulkan, and software-renderer lanes.
