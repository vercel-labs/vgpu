import { describe, expect, test, vi } from "vitest";
import { parseOsRelease, prescriptionsFor, probeRegistry, runDoctor, runProbeRegistry } from "../lib/doctor/run.js";

const linux = {
  platform: "linux",
  arch: "x64",
  env: {},
  osRelease: { ID: "ubuntu", ID_LIKE: "debian" },
  exists: (path: string) => path.includes("libvulkan.so.1"),
  listIcds: () => ["/usr/share/vulkan/icd.d/lvp_icd.x86_64.json"],
  command: () => null,
};

describe("doctor probe registry", () => {
  test("runs only probes whose platform predicate matches, in registry order", async () => {
    const probes = [
      { id: "all", platforms: ["all"], run: () => ({ status: "ok", evidence: "all" }) },
      { id: "linux", platforms: ["linux"], run: () => ({ status: "ok", evidence: "linux" }) },
      { id: "darwin", platforms: ["darwin"], run: () => ({ status: "ok", evidence: "darwin" }) },
    ];
    await expect(runProbeRegistry(probes, linux)).resolves.toEqual([
      { probe: "all", status: "ok", evidence: "all" },
      { probe: "linux", status: "ok", evidence: "linux" },
    ]);
  });
});

describe("doctor prescriptions", () => {
  test("parses quoted os-release fixtures", () => {
    expect(parseOsRelease('ID="ubuntu"\nID_LIKE="debian linux"\nVERSION_ID=24.04\n')).toEqual({ ID: "ubuntu", ID_LIKE: "debian linux", VERSION_ID: "24.04" });
  });

  test("reads the Mesa driver version instead of the Vulkan API version", async () => {
    const findings = await runProbeRegistry(probeRegistry, {
      ...linux,
      command: (name: string) => name === "vulkaninfo" ? "Vulkan Instance Version: 1.4.304\ndriverInfo = Mesa 25.0.7" : null,
      glibc: "2.41",
    });
    expect(findings.find((finding) => finding.probe === "linux-mesa")).toMatchObject({ status: "ok", evidence: expect.stringContaining("Mesa 25.0") });
  });

  test("selects executable apt, dnf, and generic lavapipe fixes", () => {
    expect(prescriptionsFor({ ID: "ubuntu" }).install).toBe("apt-get update && apt-get install -y libvulkan1 libdrm2 zlib1g libzstd1 libudev1 mesa-vulkan-drivers");
    expect(prescriptionsFor({ ID: "amzn", VERSION_ID: "2023", ID_LIKE: "fedora" }).install).toBe("dnf install -y vulkan-loader libdrm zlib libzstd systemd-libs mesa-vulkan-drivers");
    expect(prescriptionsFor({ ID: "unknown" }).install).toContain("Vulkan loader, libdrm, zlib, zstd, libudev, and Mesa Vulkan drivers");
    expect(prescriptionsFor({ ID: "debian" }).env).toBe("export VK_ICD_FILENAMES=$(find /usr/share/vulkan/icd.d -name 'lvp_icd*.json' | head -1)\nexport VK_DRIVER_FILES=$VK_ICD_FILENAMES");
  });
});

describe("doctor output contract", () => {
  test("--no-render emits unverified JSON and exits 1", async () => {
    const result = await runDoctor(["--no-render"], linux);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout!);
    expect(report).toMatchObject({ verdict: "unverified", adapter: null, findings: expect.any(Array) });
    expect(report.findings.every((finding: object) => Object.keys(finding).includes("probe") && Object.keys(finding).includes("status") && Object.keys(finding).includes("evidence"))).toBe(true);
    expect(report.findings.at(-1)).toMatchObject({ probe: "render", status: "skip" });
  });

  test("a successful real render is healthy and reports even a CPU adapter as ok", async () => {
    const dispose = vi.fn();
    const result = await runDoctor([], {
      ...linux,
      render: async () => ({ adapter: { name: "llvmpipe", type: "cpu" }, dispose }),
    });
    expect(result.code).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(result.stdout!)).toMatchObject({ verdict: "healthy", adapter: { name: "llvmpipe", type: "cpu" } });
  });

  test("missing ICD plus failed render is unhealthy with an exact distro prescription", async () => {
    const result = await runDoctor([], {
      ...linux,
      exists: () => false,
      listIcds: () => [],
      render: async () => { throw new Error("adapter unavailable"); },
    });
    const report = JSON.parse(result.stdout!);
    expect(result.code).toBe(1);
    expect(report.verdict).toBe("unhealthy");
    expect(report.findings.find((finding: { probe: string }) => finding.probe === "linux-vulkan-icd")).toMatchObject({
      status: "fail",
      prescription: expect.stringContaining("apt-get update && apt-get install -y libvulkan1 libdrm2 zlib1g libzstd1 libudev1 mesa-vulkan-drivers"),
    });
  });
});
