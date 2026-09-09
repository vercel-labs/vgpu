import { installedTintWorkerPath } from "./compiler/installed-worker.js";
import {
  checkMetalProject,
  type CheckedMetalProject,
} from "./tooling/check-project.js";
import {
  doctorMetalToolchain,
  type NativeDoctorReport,
} from "./tooling/doctor.js";

export const nativeCliProtocol = 1;

export type NativeCommandInput = {
  readonly signal?: AbortSignal;
} & (
  | { readonly command: "doctor"; readonly configurationPath?: never }
  | {
      readonly command: "check" | "build" | "verify";
      readonly configurationPath: string;
    }
);

export interface NativeCommandResult {
  readonly code: 0 | 1;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Protocol-one companion; the public shim owns signals and process output. */
export async function runNativeCommand(
  input: NativeCommandInput
): Promise<NativeCommandResult> {
  if (input.command === "check") {
    const report = await checkMetalProject({
      configurationPath: input.configurationPath,
      workerPath: installedTintWorkerPath(),
      signal: input.signal,
    });
    return { code: 0, stdout: renderCheckReport(report) };
  }
  if (input.command !== "doctor")
    return {
      code: 1,
      stderr: `Native command ${input.command} is not implemented by this companion yet.\n`,
    };
  // No asynchronous discovery before the doctor captures its host environment.
  const report = await doctorMetalToolchain({
    workerPath: installedTintWorkerPath(),
    signal: input.signal,
  });
  return {
    code: report.verdict === "healthy" ? 0 : 1,
    stdout: renderDoctorReport(report),
  };
}

function renderCheckReport(report: CheckedMetalProject): string {
  return [
    "Native shaders: valid",
    `Module: ${report.moduleName}`,
    ...report.programs.map(
      (program) => `[ok] ${program.name}: ${program.stages.join(", ")}`
    ),
    `Input fingerprint: ${report.inputFingerprint}`,
    "",
  ].join("\n");
}

function renderDoctorReport(report: NativeDoctorReport): string {
  const lines = [`Native toolchain: ${report.verdict}`];
  for (const finding of report.findings) {
    lines.push(
      `[${finding.status}] ${finding.probe}: ${finding.evidence.replace(
        /\r\n|\r|\n/gu,
        "\n  "
      )}`
    );
    if (finding.prescription !== undefined)
      lines.push(
        `  Next: ${finding.prescription.replace(/\r\n|\r|\n/gu, "\n    ")}`
      );
  }
  return `${lines.join("\n")}\n`;
}
