/**
 * Wording for the CPU software renderer notice.
 *
 * Dawn, the Vulkan loader and Mesa write their own startup diagnostics straight to file
 * descriptor 2 from native code (`error: XDG_RUNTIME_DIR is invalid or not set in the
 * environment.`, `Warning: Vulkan shaderUniform*ArrayDynamicIndexing required.`). The
 * prebuilt `webgpu` binding exposes no logging hook, so those lines cannot be captured or
 * relabelled from JavaScript. vgpu instead prints one clearly labelled notice after the
 * adapter is known, telling the reader that the scary looking lines above are harmless and
 * that rendering continues on the CPU.
 */
export type SoftwareAdapterInfo = (GPUAdapterInfo & { readonly adapterType?: string; readonly type?: string }) | null | undefined;
export type SoftwareFallbackReason = "vendor-driver-failed" | "no-adapter" | "cpu-adapter-selected";
export type SoftwareFallbackNotice = { readonly adapter: string; readonly reason: SoftwareFallbackReason };

const softwareNamePattern = /llvmpipe|lavapipe|swiftshader|software|cpu/iu;

export function isSoftwareAdapter(info: SoftwareAdapterInfo): boolean {
  if (!info) return false;
  return info.adapterType === "cpu" || info.type === "cpu" || softwareNamePattern.test(`${info.description ?? ""} ${info.device ?? ""} ${info.vendor ?? ""}`);
}

export function softwareAdapterName(info: SoftwareAdapterInfo): string {
  return String(info?.description || info?.device || info?.vendor || "").trim() || "lavapipe";
}

export function formatSoftwareFallbackNotice({ adapter, reason }: SoftwareFallbackNotice): string {
  const cause = reason === "vendor-driver-failed"
    ? "a vendor Vulkan driver is present but failed to initialize"
    : reason === "no-adapter"
      ? "no GPU adapter was found"
      : "no hardware GPU adapter is available";
  return [
    `vgpu: notice — ${cause}; using CPU software renderer (${adapter}). This is expected on a machine without a usable GPU, and rendering continues normally.`,
    "vgpu: notice — Vulkan/XDG_RUNTIME_DIR \"error\" and \"Warning\" lines printed above come from the GPU driver stack, not from vgpu, and are harmless. Run `npx vgpu doctor` for details.",
  ].join("\n");
}
