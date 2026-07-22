# Lavapipe portable renderer build

This recipe builds Mesa Lavapipe with LLVM statically linked, packages the renderer and relative-path Vulkan ICD manifest, and validates the result against Dawn in a clean container with no distro Mesa driver installed.

## Build and validate

```bash
# Defaults: Mesa 25.0.7 and the host architecture.
infra/lavapipe-build/build.sh

# Explicit matrix target (run this on the matching native runner).
MESA_VERSION=25.0.7 ARCH=arm64 infra/lavapipe-build/build.sh

infra/lavapipe-build/validate.sh \
  lavapipe-out/mesa-lavapipe-25.0.7-linux-arm64.tar.gz \
  "$HOME/.cache/vgpu/dawn/0.4.0-vgpu.1/linux-arm64-gnu/dawn-linux-arm64-gnu.node"
```

`OUTPUT_DIR` controls the build output. For a Mesa version other than 25.0.7, set both `MESA_VERSION` and the archive's trusted `MESA_SHA256`; the default checksum is only valid for 25.0.7. Builds are native: use an arm64 host for `ARCH=arm64` and an x64 host for `ARCH=x64`.

## Validated Mesa 25.0.7 result

The arm64 prototype produced:

| File | Raw bytes | gzip-9 bytes |
|---|---:|---:|
| `libvulkan_lvp.so` | 57,364,920 | 20,510,852 |
| `lvp_icd.json` | 124 | 131 |
| release-shaped tarball | — | **20,576,758 (20.58 MB)** |

Its tarball SHA256 was `86a4093d97f1a307fd1c6af96ecac09d4983b0ff3459b4dfc551e6ffdd70774a`. The clean-container harness passed three fresh processes: 17 Dawn features including `shader-f16`, `maxComputeInvocationsPerWorkgroup` 1024, exact 64×64 readback (`[64,128,191,255]` center, `[0,0,0,255]` corner, 1,352 nonblack pixels), and no uncaptured errors. Cold/warm timings were 144.689 ms, 31.980 ms, and 22.919 ms.

## Build and runtime gotchas

- Mesa 25.0.7 has **no `.sha256sum` sidecar**. The Dockerfile therefore pins the archive SHA256 inline: `592272df3cf01e85e7db300c449df5061092574d099da275d19e97ef0510f8a6`.
- `-Dshared-llvm=disabled` requires `llvm-19-dev` **and `libpolly-19-dev`**. Debian's static LLVM metadata references Polly; omitting its static archives fails the final link with `cannot find -lPolly` / `cannot find -lPollyISL`.
- `-Db_lto=true` is validated. The selected static target is native-only rather than every LLVM backend.
- Mesa reports `GALLIVM_USE_ORCJIT=0` in this configuration. llvmpipe uses MCJIT, even though LLVM JIT/execution components are statically present.
- Static LLVM does not make the renderer fully static. At runtime the system must provide the Vulkan loader (`libvulkan.so.1`, required by Dawn), `libzstd.so.1`, and `libz.so.1`, plus normal libc/libstdc++ and device-support libraries. **This loader/runtime dependency closure is a design input for phase 2**, not something the renderer artifact can silently avoid.

The build records `ldd`, `readelf -d`, and LLVM static-link component evidence under `lavapipe-out/evidence/`. The archive contains only `libvulkan_lvp.so` and `lvp_icd.json`; checksums are emitted beside the archive and under `asset/SHA256SUMS`.
