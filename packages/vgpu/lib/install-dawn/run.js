export async function runInstallDawn(args, dependencies = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      code: 0,
      stdout:
        "Usage: vgpu install-dawn\n\nDownload and verify the portable Dawn binary for this platform.\nHonors GH_TOKEN/GITHUB_TOKEN and VGPU_CACHE_DIR.\n",
    };
  }
  if (args.length > 0) return { code: 1, stderr: `Unknown install-dawn option: ${args[0]}\n` };

  try {
    const install = dependencies.installDawn ?? (await import("@vgpu/adapter-node/install-dawn")).installDawn;
    const result = await install();
    return {
      code: 0,
      stdout: `${result.downloaded ? "Downloaded" : "Verified"} Dawn prebuild: ${result.path}\n`,
    };
  } catch (error) {
    const details = error && typeof error === "object" ? error : {};
    const code = details.code ? `${details.code}: ` : "";
    const fix = details.fix ? `\n${details.fix}` : "";
    return { code: 1, stderr: `${code}${String(details.message ?? error)}${fix}\n` };
  }
}
