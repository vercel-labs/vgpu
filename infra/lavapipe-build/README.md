# Lavapipe portable renderer build

This recipe builds Mesa Lavapipe with LLVM and the C++ runtime statically linked, packages the renderer plus a relative-path Vulkan ICD manifest, and validates the result against Dawn without a distro Mesa driver.

## Portability baseline

The builder is **Debian 11 Bullseye (glibc 2.31)**, matching the portable Dawn prebuild's old-host strategy. The original Trixie prototype required `GLIBC_2.38` and could not load on the current Debian 12/Bookworm sandbox (glibc 2.36). The Bullseye build's measured maximum is **GLIBC 2.29**; `validate.sh` rejects anything above the documented 2.31 floor. `libstdc++` and `libgcc` are linked statically, so the artifact has no `GLIBCXX` or `CXXABI` requirements.

Bullseye predates required build dependencies, so the recipe deliberately:

- installs LLVM 19.1.7 from apt.llvm.org's official Bullseye repository;
- installs `libpolly-19-dev`, whose package was audited to contain both `libPolly.a` and `libPollyISL.a`;
- builds pinned libdrm 2.4.124 from source in the Bullseye userspace because Mesa 25 requires >=2.4.109 while Bullseye ships 2.4.104; and
- installs Meson 1.7.0 explicitly.

## Build and validate

```bash
# Defaults: Mesa 25.0.7 and the host architecture.
infra/lavapipe-build/build.sh

# Run both compatibility proofs with the portable Dawn addon.
VALIDATION_IMAGE=node:24-bookworm infra/lavapipe-build/validate.sh \
  lavapipe-out/mesa-lavapipe-25.0.7-linux-arm64.tar.gz /path/to/portable-dawn.node \
  lavapipe-validation-bookworm
VALIDATION_IMAGE=node:24-trixie infra/lavapipe-build/validate.sh \
  lavapipe-out/mesa-lavapipe-25.0.7-linux-arm64.tar.gz /path/to/portable-dawn.node \
  lavapipe-validation-trixie
```

`OUTPUT_DIR` controls output. For a Mesa version other than 25.0.7, set both `MESA_VERSION` and its trusted `MESA_SHA256`. Builds are native: use an arm64 host for `ARCH=arm64` and x64 for `ARCH=x64`.

## Validated Mesa 25.0.7 arm64 result

| File | Bytes |
|---|---:|
| `libvulkan_lvp.so` | **56,864,480** |
| `lvp_icd.json` | 124 |
| release-shaped tarball | **20,568,206 (20.57 MB)** |

Tarball SHA256: `eac1477d6404af2d63fc08104e980d0cbbf657470c966a0bc638099c00d3dcac`.

Both clean Bookworm and Trixie containers passed three fresh processes: 17 Dawn features including `shader-f16`, `maxComputeInvocationsPerWorkgroup` 1024, exact 64×64 readback (`[64,128,191,255]` center, `[0,0,0,255]` corner, 1,352 nonblack pixels), and no uncaptured errors.

The asset also passed directly on the current Bookworm host using `vgpu@0.1.6` and its portable Dawn loader: `vgpu doctor` reported **healthy**, adapter **llvmpipe: Mesa 25.0.7 (LLVM 19.1.7)**, type `cpu`; host `ldd` resolved every dependency and render/dispose exited cleanly.

## Build and runtime gotchas

- Mesa 25.0.7 has no `.sha256sum` sidecar. Its archive SHA256 is pinned inline: `592272df3cf01e85e7db300c449df5061092574d099da275d19e97ef0510f8a6`.
- Omitting Polly static archives fails the final link with `cannot find -lPolly` / `cannot find -lPollyISL`.
- `-Dshared-llvm=disabled` and `-Db_lto=true` are validated. Mesa reports `GALLIVM_USE_ORCJIT=0`, so llvmpipe uses MCJIT.
- Static LLVM does not make the renderer fully static. Runtime dependencies include the Vulkan loader (`libvulkan.so.1`, required by Dawn), `libzstd.so.1`, `libz.so.1`, libdrm, libudev, libm, and libc. **This dependency closure is a phase-2 design input.**

The build records `ldd`, dynamic/version symbol audits, and LLVM static-link components under `lavapipe-out/evidence/`. The archive itself contains only `libvulkan_lvp.so` and `lvp_icd.json`.
