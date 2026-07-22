import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const statuses = new Set(["ok", "warn", "fail", "skip"]);

export const probeRegistry = [
  { id: "binary-resolution", platforms: ["all"], run: probeBinaryResolution },
  { id: "binary-compatibility", platforms: ["all"], run: probeBinaryCompatibility },
  { id: "linux-glibc", platforms: ["linux"], run: probeGlibc },
  { id: "linux-vulkan-loader", platforms: ["linux"], run: probeVulkanLoader },
  { id: "linux-vulkan-icd", platforms: ["linux"], run: probeVulkanIcd },
  { id: "linux-mesa", platforms: ["linux"], run: probeMesa },
  { id: "linux-display", platforms: ["linux"], run: probeDisplay },
  { id: "macos-version", platforms: ["darwin"], run: probeMacVersion },
  { id: "macos-architecture", platforms: ["darwin"], run: probeMacArchitecture },
  { id: "windows-version", platforms: ["win32"], run: probeWindowsVersion },
];

export async function runProbeRegistry(registry, context) {
  const findings = [];
  for (const probe of registry) {
    if (!probe.platforms.includes("all") && !probe.platforms.includes(context.platform)) continue;
    const result = await probe.run(context);
    if (!statuses.has(result.status)) throw new Error(`Invalid status from probe ${probe.id}: ${result.status}`);
    findings.push({ probe: probe.id, ...result });
  }
  return findings;
}

export async function runDoctor(args, overrides = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    return { code: 0, stdout: "Usage: vgpu doctor [--no-render] [--pretty]\n\nDiagnose whether this machine can render headless with vgpu/node. JSON is written by default.\n" };
  }
  const unknown = args.find((arg) => arg !== "--no-render" && arg !== "--pretty");
  if (unknown) return { code: 1, stderr: `Unknown doctor option: ${unknown}\n` };

  const context = createContext(overrides);
  const findings = await runProbeRegistry(probeRegistry, context);
  let adapter = null;
  let verdict = "unverified";

  if (args.includes("--no-render")) {
    findings.push({ probe: "render", status: "skip", evidence: "Real render skipped by --no-render; health is unverified." });
  } else {
    let rendered;
    try {
      rendered = await context.render();
      adapter = rendered.adapter;
      verdict = "healthy";
      findings.push({ probe: "render", status: "ok", evidence: `Rendered and read back a 16x16 offscreen target with ${adapter.name} (${adapter.type}).` });
    } catch (error) {
      verdict = "unhealthy";
      findings.push({ probe: "render", status: "fail", evidence: errorEvidence(error), prescription: lavapipePrescription(context.osRelease) });
    } finally {
      rendered?.dispose?.();
    }
  }

  const report = { verdict, adapter, findings };
  return { code: verdict === "healthy" ? 0 : 1, stdout: args.includes("--pretty") ? prettyReport(report) : `${JSON.stringify(report)}\n` };
}

function createContext(overrides) {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const command = overrides.command ?? defaultCommand;
  return {
    platform,
    arch: overrides.arch ?? process.arch,
    env,
    osRelease: overrides.osRelease ?? (platform === "linux" ? parseOsRelease(safeRead("/etc/os-release")) : {}),
    exists: overrides.exists ?? existsSync,
    listIcds: overrides.listIcds ?? (() => defaultIcdFiles(env)),
    command,
    glibc: overrides.glibc ?? runtimeGlibc(),
    release: overrides.release ?? command(platform === "win32" ? "cmd" : "uname", platform === "win32" ? ["/c", "ver"] : ["-r"]),
    render: overrides.render ?? realRender,
  };
}

function probeBinaryResolution(context) {
  if (context.env.VGPU_DAWN_BINARY) {
    const path = resolve(context.env.VGPU_DAWN_BINARY);
    return context.exists(path)
      ? { status: "ok", evidence: `VGPU_DAWN_BINARY resolves to ${path}.` }
      : { status: "fail", evidence: `VGPU_DAWN_BINARY points to missing file ${path}.`, prescription: "Set VGPU_DAWN_BINARY to a verified Dawn .node file, or unset it to use the normal resolution chain." };
  }
  const cache = context.env.VGPU_CACHE_DIR ?? context.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  try {
    const stock = require.resolve("webgpu");
    return { status: "ok", evidence: `Normal chain will try vgpu cache under ${cache}, then stock webgpu at ${stock}, then the downloadable prebuild.` };
  } catch {
    return { status: "warn", evidence: `No stock webgpu package resolved; normal chain will try vgpu cache under ${cache}, then download the portable Dawn prebuild if supported.` };
  }
}

function probeBinaryCompatibility(context) {
  const path = context.env.VGPU_DAWN_BINARY;
  if (!path) return { status: "ok", evidence: `Normal Dawn resolution selects a binary for process ${context.platform}/${context.arch}.` };
  const lower = path.toLowerCase();
  const namedArch = ["arm64", "x64", "ia32"].find((arch) => lower.includes(arch));
  const namedPlatform = lower.includes("linux") ? "linux" : lower.includes("darwin") || lower.includes("macos") ? "darwin" : lower.includes("win32") || lower.includes("windows") ? "win32" : null;
  if ((namedArch && namedArch !== context.arch) || (namedPlatform && namedPlatform !== context.platform)) {
    return { status: "fail", evidence: `${path} appears to target ${namedPlatform ?? "unknown platform"}/${namedArch ?? "unknown architecture"}, but this process is ${context.platform}/${context.arch}.`, prescription: "Use a Dawn .node binary matching process.platform and process.arch." };
  }
  return { status: "ok", evidence: `${path} has no filename mismatch with process ${context.platform}/${context.arch}; native loading is verified by the render probe.` };
}

function probeGlibc(context) {
  return context.glibc ? { status: "ok", evidence: `glibc ${context.glibc}.` } : { status: "warn", evidence: "glibc version could not be detected (the host may use another libc)." };
}

function probeVulkanLoader(context) {
  const paths = ["/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/aarch64-linux-gnu/libvulkan.so.1"];
  const found = paths.find(context.exists);
  const ldconfig = context.command("ldconfig", ["-p"]);
  if (found || /libvulkan\.so\.1/u.test(ldconfig ?? "")) return { status: "ok", evidence: found ? `Vulkan loader found at ${found}.` : "Vulkan loader libvulkan.so.1 is registered with ldconfig." };
  return { status: "fail", evidence: "Vulkan loader libvulkan.so.1 was not found.", prescription: prescriptionsFor(context.osRelease).install };
}

function probeVulkanIcd(context) {
  const files = context.listIcds();
  return files.length
    ? { status: "ok", evidence: `Vulkan ICD manifests: ${files.join(", ")}.` }
    : { status: "fail", evidence: "No Vulkan ICD manifest was found in /usr/share/vulkan/icd.d, VK_ICD_FILENAMES, or VK_DRIVER_FILES.", prescription: lavapipePrescription(context.osRelease) };
}

function probeMesa(context) {
  const outputs = [context.command("pkg-config", ["--modversion", "vulkan"]), context.command("glxinfo", ["-B"]), context.command("vulkaninfo", ["--summary"])].filter(Boolean).join("\n");
  const match = outputs.match(/(?:Mesa\s*)?(\d+)\.(\d+)(?:\.\d+)?/iu);
  if (!match) return { status: "skip", evidence: "Mesa version was not detected; the render probe verifies the active driver." };
  const version = `${match[1]}.${match[2]}`;
  return Number(match[1]) < 23
    ? { status: "warn", evidence: `Mesa ${version} detected; Mesa 23 or newer is recommended for lavapipe.`, prescription: prescriptionsFor(context.osRelease).install }
    : { status: "ok", evidence: `Mesa ${version} detected (>=23).` };
}

function probeDisplay(context) {
  const display = context.env.DISPLAY;
  const wayland = context.env.WAYLAND_DISPLAY;
  return !display && !wayland
    ? { status: "ok", evidence: "DISPLAY and WAYLAND_DISPLAY are unset; this is valid for headless Vulkan." }
    : { status: "ok", evidence: `Display state: DISPLAY=${display ?? "unset"}, WAYLAND_DISPLAY=${wayland ?? "unset"}; Dawn may select its OpenGL path.` };
}
function probeMacVersion(context) { return { status: "ok", evidence: `macOS ${context.command("sw_vers", ["-productVersion"]) ?? context.release ?? "unknown"}.` }; }
function probeMacArchitecture(context) {
  const translated = context.command("sysctl", ["-in", "sysctl.proc_translated"]) === "1";
  return { status: "ok", evidence: `${context.arch}${translated ? " under Rosetta 2" : " native process"}; binary compatibility is verified by loading and rendering.` };
}
function probeWindowsVersion(context) { return { status: "ok", evidence: `Windows ${context.release ?? "unknown"}; D3D12 availability is verified by the render probe.` }; }

export function prescriptionsFor(osRelease) {
  const ids = `${osRelease.ID ?? ""} ${osRelease.ID_LIKE ?? ""}`.toLowerCase();
  const install = /debian|ubuntu/u.test(ids)
    ? "apt-get update && apt-get install -y libvulkan1 mesa-vulkan-drivers"
    : /fedora|rhel|centos|amzn/u.test(ids)
      ? "dnf install -y vulkan-loader mesa-vulkan-drivers"
      : "Install the system Vulkan loader and Mesa Vulkan drivers (lavapipe) with this distribution's package manager.";
  const icd = findLikelyLavapipeIcd();
  return { install, env: `export VK_ICD_FILENAMES=${icd}\nexport VK_DRIVER_FILES=${icd}` };
}
function lavapipePrescription(osRelease) {
  const prescription = prescriptionsFor(osRelease);
  return `${prescription.install}\n${prescription.env}`;
}
function findLikelyLavapipeIcd() {
  const candidates = ["/usr/share/vulkan/icd.d/lvp_icd.x86_64.json", "/usr/share/vulkan/icd.d/lvp_icd.aarch64.json", "/usr/share/vulkan/icd.d/lvp_icd.json"];
  return candidates.find(existsSync) ?? candidates[0];
}

async function realRender() {
  const { init } = await import("vgpu/node");
  const gpu = await init();
  try {
    const target = gpu.target({ size: [16, 16], format: "rgba8unorm", label: "vgpu-doctor" });
    const effect = gpu.effect("@fragment fn main() -> @location(0) vec4f { return vec4f(0.25, 0.5, 0.75, 1.0); }");
    gpu.frame((frame) => frame.pass({ target }, (encoder) => encoder.draw(effect)));
    const pixels = await target.read();
    if (!pixels || pixels.byteLength < 16 * 16 * 4) throw new Error("render readback returned too few bytes");
    const info = gpu.device?.adapterInfo ?? {};
    const name = info.description || info.device || info.vendor || "unknown adapter";
    const type = info.adapterType || info.type || (/llvmpipe|lavapipe|swiftshader|software|cpu/iu.test(name) ? "cpu" : "unknown");
    return { adapter: { name: String(name), type: String(type) }, dispose: () => gpu.dispose() };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}

export function parseOsRelease(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/u, "$2");
  }
  return result;
}
function defaultIcdFiles(env) {
  const explicit = [env.VK_ICD_FILENAMES, env.VK_DRIVER_FILES].filter(Boolean).flatMap((value) => value.split(":"));
  let scanned = [];
  try { scanned = readdirSync("/usr/share/vulkan/icd.d").filter((name) => name.endsWith(".json")).map((name) => join("/usr/share/vulkan/icd.d", name)); } catch {}
  return [...new Set([...explicit, ...scanned])].filter(Boolean);
}
function defaultCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000 });
  return result.status === 0 ? result.stdout.trim() : null;
}
function runtimeGlibc() { try { return process.report?.getReport()?.header?.glibcVersionRuntime ?? null; } catch { return null; } }
function safeRead(path) { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function errorEvidence(error) {
  const details = error && typeof error === "object" ? error : {};
  return `${details.code ? `${details.code}: ` : ""}${String(details.message ?? error)}`;
}
function prettyReport(report) {
  const lines = [`Verdict: ${report.verdict}`, `Adapter: ${report.adapter ? `${report.adapter.name} (${report.adapter.type})` : "none"}`, "", "Findings:"];
  for (const finding of report.findings) {
    lines.push(`  [${finding.status.toUpperCase()}] ${finding.probe}: ${finding.evidence}`);
    if (finding.prescription) lines.push(...finding.prescription.split("\n").map((line) => `    Fix: ${line}`));
  }
  return `${lines.join("\n")}\n`;
}
