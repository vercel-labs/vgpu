import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { checkMetalPackage } from "../compile.js";
import { compileMetalLibrary } from "../compiler/metal.js";
import { compilerIdentity } from "../compiler/protocol.js";

export type NativeDoctorProbe =
  | "node"
  | "host"
  | "xcode"
  | "sdk"
  | "swift"
  | "tint"
  | "metal";

export interface NativeDoctorFinding {
  readonly probe: NativeDoctorProbe;
  readonly status: "ok" | "fail" | "skip";
  readonly evidence: string;
  readonly prescription?: string;
}

export interface NativeDoctorReport {
  readonly schemaVersion: 1;
  readonly target: "macos";
  readonly verdict: "healthy" | "unhealthy";
  readonly findings: readonly NativeDoctorFinding[];
}

export class NativeDoctorError extends Error {
  readonly code = "cancelled";
  constructor(options?: ErrorOptions) {
    super("Native toolchain diagnosis was cancelled", options);
    this.name = "NativeDoctorError";
  }
}

const probes: readonly NativeDoctorProbe[] = [
  "node",
  "host",
  "xcode",
  "sdk",
  "swift",
  "tint",
  "metal",
];

/** Internal diagnostic only: no project input, package output, or GPU access. */
export async function doctorMetalToolchain(input: {
  readonly workerPath: string;
  readonly signal?: AbortSignal;
}): Promise<NativeDoctorReport> {
  const { workerPath, signal } = input;
  throwIfCancelled(signal);
  const environment = { ...process.env };
  environment.TMPDIR = resolve(environment.TMPDIR ?? tmpdir());
  if (environment.DEVELOPER_DIR !== undefined)
    environment.DEVELOPER_DIR = resolve(environment.DEVELOPER_DIR);
  const findings: NativeDoctorFinding[] = [];
  const ok = (probe: NativeDoctorProbe, evidence: string) =>
    findings.push({ probe, status: "ok", evidence });
  if (!/^22\.\d+\.\d+$/u.test(process.versions.node)) {
    findings.push({
      probe: "node",
      status: "fail",
      evidence: `Node.js ${process.versions.node} is outside the stable 22.x profile.`,
      prescription:
        "Use a stable Node.js 22 release (the project requires >=22 <23).",
    });
    return skipRemaining(findings);
  }
  ok("node", `Node.js ${process.versions.node}.`);
  if (process.platform !== "darwin") {
    findings.push({
      probe: "host",
      status: "fail",
      evidence: `Host ${process.platform}; process ${process.arch}.`,
      prescription: "Run the native Metal build tools on macOS.",
    });
    return skipRemaining(findings);
  }
  const run = async (
    probe: NativeDoctorProbe,
    requires: NativeDoctorProbe[],
    operation: () => Promise<string>,
    prescription: string
  ) => {
    throwIfCancelled(signal);
    const missing = requires.filter(
      (dependency) =>
        !findings.some(
          (finding) => finding.probe === dependency && finding.status === "ok"
        )
    );
    if (missing.length) {
      findings.push({
        probe,
        status: "skip",
        evidence: `Required ${missing.join(", ")} check did not succeed.`,
      });
      return;
    }
    try {
      const evidence = await operation();
      throwIfCancelled(signal);
      ok(probe, evidence);
    } catch (cause) {
      throwIfCancelled(signal);
      findings.push({
        probe,
        status: "fail",
        evidence: errorEvidence(cause),
        prescription,
      });
    }
  };
  await run(
    "host",
    ["node"],
    async () => {
      const version = await command(
        "/usr/bin/sw_vers",
        ["-productVersion"],
        environment,
        signal
      );
      return `macOS ${version}; process ${process.arch}.`;
    },
    "Ensure the macOS system version command is available and retry."
  );
  let scratch: string | undefined;
  try {
    await run(
      "xcode",
      ["host"],
      async () => {
        scratch = await mkdtemp(
          join(environment.TMPDIR ?? tmpdir(), "vgpu-native-doctor-")
        );
        environment.TMPDIR = scratch;
        const developerDirectory =
          environment.DEVELOPER_DIR ??
          (await command(
            "/usr/bin/xcode-select",
            ["--print-path"],
            environment,
            signal
          ));
        environment.DEVELOPER_DIR = developerDirectory;
        const xcode = await command(
          "/usr/bin/xcodebuild",
          ["-version"],
          environment,
          signal
        );
        return `${developerDirectory}: ${xcode}`;
      },
      "Select a usable full Xcode installation with DEVELOPER_DIR or Xcode settings, and ensure the temporary directory is writable."
    );
    await run(
      "sdk",
      ["xcode"],
      async () => {
        const sdkPath = await command(
          "/usr/bin/xcrun",
          ["--sdk", "macosx", "--show-sdk-path"],
          environment,
          signal
        );
        const sdkVersion = await command(
          "/usr/bin/xcrun",
          ["--sdk", "macosx", "--show-sdk-version"],
          environment,
          signal
        );
        if (!isAbsolute(sdkPath) || /[\u0000-\u001f\u007f]/u.test(sdkPath))
          throw new Error(
            "The selected macOS SDK path is not an absolute single path."
          );
        if (!/^\d+\.\d+(?:\.\d+)?$/u.test(sdkVersion))
          throw new Error(
            `The selected macOS SDK version is invalid: ${sdkVersion}.`
          );
        return `macOS SDK ${sdkVersion}: ${sdkPath}`;
      },
      "Repair the macOS SDK in the selected Xcode installation and retry."
    );
    await run(
      "swift",
      ["sdk"],
      async () => {
        const version = await command(
          "/usr/bin/xcrun",
          ["--sdk", "macosx", "swift", "--version"],
          environment,
          signal
        );
        const major = version.match(/\bSwift version (\d+)\.\d+/u)?.[1];
        if (major === undefined || Number(major) < 6)
          throw new Error(`Swift 6 or newer is required; reported ${version}.`);
        return version;
      },
      "Select an Xcode toolchain providing Swift 6 or newer."
    );
    await run(
      "tint",
      ["host"],
      async () => {
        await checkMetalPackage({
          moduleName: "NativeDoctorShaders",
          programs: [
            {
              name: "Probe",
              source: "doctor.wgsl",
              entryPoints: { compute: "native_probe" },
            },
          ],
          modules: {
            "doctor.wgsl": "@compute @workgroup_size(1) fn native_probe() {}",
          },
          workerPath,
          signal,
        });
        return `Checked WGSL semantic and Metal translation responses from pinned Tint ${compilerIdentity.upstream.revision}.`;
      },
      "Restore the vgpu-owned pinned worker for this installation; do not substitute an unverified compiler. Check temporary-directory permissions."
    );
    await run(
      "metal",
      ["sdk"],
      async () => {
        const library = await compileMetalLibrary(
          ["#include <metal_stdlib>\nkernel void vgpu_native_doctor() {}\n"],
          signal,
          { environment }
        );
        if (library.byteLength === 0)
          throw new Error("Metal linked an empty library.");
        return `Compiled and linked ${library.byteLength} bytes with macos-metal2.4 targeting macOS 14.`;
      },
      "Check the selected Xcode installation and its Metal Toolchain component in Xcode Settings > Components; if missing, install it yourself with xcodebuild -downloadComponent metalToolchain. Check temporary-directory permissions."
    );
  } finally {
    if (scratch !== undefined) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (cause) {
        if (signal?.aborted)
          throw new NativeDoctorError({
            cause: new AggregateError(
              [signal.reason, cause],
              "Cancellation cleanup failed"
            ),
          });
        const last = findings.length - 1;
        findings[last] = {
          ...findings[last],
          status: "fail",
          evidence: `${
            findings[last].evidence
          } Temporary cleanup failed: ${errorEvidence(cause)}`,
          prescription: `Inspect the leftover temporary directory ${scratch}, repair its permissions, and remove only that directory before retrying.`,
        };
      }
    }
  }
  throwIfCancelled(signal);
  return {
    schemaVersion: 1,
    target: "macos",
    verdict: findings.every((finding) => finding.status === "ok")
      ? "healthy"
      : "unhealthy",
    findings,
  };
}

function skipRemaining(findings: NativeDoctorFinding[]): NativeDoctorReport {
  const prerequisite = findings.at(-1)!.probe;
  return {
    schemaVersion: 1,
    target: "macos",
    verdict: "unhealthy",
    findings: [
      ...findings,
      ...probes.slice(findings.length).map((probe) => ({
        probe,
        status: "skip" as const,
        evidence: `Required ${prerequisite} check did not succeed.`,
      })),
    ],
  };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NativeDoctorError({ cause: signal.reason });
}

function errorEvidence(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(
    0,
    8192
  );
}

function command(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    let response: { error: Error | null; stdout: string } | undefined;
    const child = execFile(
      executable,
      args,
      {
        env,
        signal,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        response = { error, stdout };
      }
    );
    child.once("close", () => {
      if (!response)
        reject(new Error("Discovery process closed without a result."));
      else if (response.error) reject(response.error);
      else if (!response.stdout.trim())
        reject(new Error(`${executable} produced no discovery output.`));
      else resolve(response.stdout.trim());
    });
    child.stdin?.end();
  });
}
