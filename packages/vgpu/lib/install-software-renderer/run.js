export async function runInstallSoftwareRenderer(args, dependencies = {}) {
  if (args.includes("--help") || args.includes("-h")) return {
    code: 0,
    stdout: "Usage: vgpu install-software-renderer\n\nDownload and sha256-verify the portable CPU software renderer for this platform.\nHonors VGPU_CACHE_DIR.\n",
  };
  if (args.length > 0) return { code: 1, stderr: `Unknown install-software-renderer option: ${args[0]}\n` };
  try {
    const install = dependencies.installSoftwareRenderer ?? (await import("@vgpu/adapter-node/install-software-renderer")).installSoftwareRenderer;
    const result = await install();
    return { code: 0, stdout: `${result.downloaded ? "Downloaded" : "Verified"} software renderer: ${result.path}\n` };
  } catch (error) {
    const details = error && typeof error === "object" ? error : {};
    const code = details.code ? `${details.code}: ` : "";
    const fix = details.fix ? `\n${details.fix}` : "";
    return { code: 1, stderr: `${code}${String(details.message ?? error)}${fix}\n` };
  }
}
