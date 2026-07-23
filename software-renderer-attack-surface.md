# Software renderer attack-surface notes

For adversarial QA of Phase 2.

## Network and integrity boundary

- Downloader: `packages/adapter-node/src/software-renderer-installer.ts`.
- Cache verifier/private loader: `packages/adapter-node/src/software-renderer-cache.ts`.
- Assets are pinned by release URL and archive SHA-256 for Linux x64/arm64. The extracted ICD JSON and shared-object bytes also have architecture-specific pinned hashes.
- Downloads stream to a mode-0600 uniquely named temporary file. The tar member list must be exactly `lvp_icd.json` and `libvulkan_lvp.so` before extraction; extraction disables archive owner/permission restoration.
- The system `tar` executable is invoked only after archive SHA-256 verification. QA should test PATH replacement, malformed archives, redirects, partial responses, and process interruption.

## Cache and concurrency boundary

- Root selection: explicit installer `cacheRoot`, then `VGPU_CACHE_DIR`, then `XDG_CACHE_HOME`, then `~/.cache`.
- Cache location: `<root>/vgpu/software-renderer/25.0.7-vgpu.1/linux-<arch>`.
- Concurrent installers use independent UUID temporary directories and atomic directory rename. A losing installer accepts the winner only after full archive and extracted-file verification.
- Cache files must be regular non-symlinks. Before Vulkan sees them, the ICD JSON and shared library are copied from `O_NOFOLLOW` file descriptors into a private mode-0700 temporary directory while hashing those exact bytes. `VK_ICD_FILENAMES` points only at that private copy.
- QA should race replacement/symlink swaps at every cache check/copy boundary, use unwritable or symlinked ancestors, interrupt before rename, and run concurrent installs with corrupt/valid responders.

## Environment and native lifecycle boundary

- `VGPU_ADAPTER=software|hardware` wins over the code option; invalid values fail before native loading.
- `VK_ICD_FILENAMES` is temporarily replaced only for a forced/consented software-renderer attempt and restored afterward. User `VK_DRIVER_FILES` is not changed.
- Auto mode performs vendor discovery first. After a zero-adapter result it creates a fresh Dawn native instance while the private lavapipe ICD override is active. Dawn native re-initialization is sensitive; stress repeated failures and mixed mode calls in one process.
- Vendor-ICD evidence is detected from `VK_ICD_FILENAMES`, `VK_DRIVER_FILES`, or `/usr/share/vulkan/icd.d/*.json`, matching doctor discovery.
