import { MetalCompileError } from "./compiler/errors.js";
import { captureToolEnvironment } from "./compiler/environment.js";
import { installedTintWorkerPath } from "./compiler/installed-worker.js";
import {
  checkMetalProject,
  type CheckedMetalProject,
} from "./tooling/check-project.js";
import {
  doctorMetalToolchain,
  type NativeDoctorReport,
} from "./tooling/doctor.js";
import { prepareMetalProject } from "./tooling/prepare-project.js";
import {
  MetalPublicationError,
  publishPreparedMetalOutput,
} from "./tooling/publication-staging.js";
import { verifyMetalProject } from "./tooling/verify-project.js";

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
    try {
      const report = await checkMetalProject({
        configurationPath: input.configurationPath,
        workerPath: installedTintWorkerPath(),
        signal: input.signal,
      });
      return { code: 0, stdout: renderCheckReport(report) };
    } catch (error) {
      return compilerFailureResult(error, input.signal);
    }
  }
  if (input.command === "build") {
    const environment = captureToolEnvironment();
    const { configurationPath, signal } = input;
    const prepared = await prepareMetalProject({
      configurationPath,
      workerPath: installedTintWorkerPath(),
      signal,
      environment,
    });
    try {
      const receipt = await publishPreparedMetalOutput({
        prepared,
        signal,
        environment,
      });
      return {
        code: 0,
        stdout: [
          "Native package: published",
          `Module: ${prepared.project.configuration.moduleName}`,
          `Output: ${receipt.outputPath}`,
          `Input fingerprint: ${prepared.project.inputFingerprint}`,
          `Record SHA-256: ${receipt.recordSHA256}`,
          "",
        ].join("\n"),
      };
    } catch (error) {
      if (!(error instanceof MetalPublicationError)) throw error;
      return { code: 1, stderr: renderPublicationError(error) };
    }
  }
  if (input.command === "verify") {
    const report = await verifyMetalProject({
      configurationPath: input.configurationPath,
      signal: input.signal,
    });
    return {
      code: 0,
      stdout: [
        "Native package: current",
        `Module: ${report.moduleName}`,
        `Output: ${report.outputPath}`,
        `Input fingerprint: ${report.inputFingerprint}`,
        "",
      ].join("\n"),
    };
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

function compilerFailureResult(
  error: unknown,
  signal?: AbortSignal
): NativeCommandResult {
  if (
    signal?.aborted ||
    !(error instanceof MetalCompileError) ||
    error.diagnostics.length === 0 ||
    !error.diagnostics.every(isCheckDiagnostic)
  )
    throw error;
  return { code: 1, stderr: renderCheckDiagnostics(error.diagnostics) };
}

function renderPublicationError(error: MetalPublicationError): string {
  const lines = [
    `Native publication: ${error.outcome}`,
    `[error] ${error.code}: ${error.message.replace(/\r\n|\r|\n/gu, "\n  ")}`,
  ];
  if (error.recoveryPaths.length > 0)
    lines.push(
      "Inspect retained paths (not cleanup authority):",
      ...error.recoveryPaths.map((path) => `  ${path}`)
    );
  return `${lines.join("\n")}\n`;
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

interface CheckDiagnostic {
  readonly code: string;
  readonly severity: "note" | "warning" | "error";
  readonly phase:
    | "protocol"
    | "wgsl"
    | "inspect"
    | "lower"
    | "generate"
    | "internal";
  readonly message: string;
  readonly location?: {
    readonly kind: "generated-wgsl";
    readonly virtualPath: string;
    readonly start: { readonly line: number; readonly column: number };
  };
}

function isCheckDiagnostic(value: unknown): value is CheckDiagnostic {
  // The protocol already validates diagnostics; narrow every consumed field, without filtering entries.
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    typeof value.severity !== "string" ||
    !["note", "warning", "error"].includes(value.severity) ||
    typeof value.phase !== "string" ||
    !["protocol", "wgsl", "inspect", "lower", "generate", "internal"].includes(
      value.phase
    )
  )
    return false;
  if (!("location" in value)) return true;
  const location = value.location;
  return (
    value.phase === "wgsl" &&
    isRecord(location) &&
    location.kind === "generated-wgsl" &&
    typeof location.virtualPath === "string" &&
    location.virtualPath.length > 0 &&
    isRecord(location.start) &&
    isSourcePosition(location.start.line) &&
    isSourcePosition(location.start.column)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourcePosition(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
  );
}

function renderCheckDiagnostics(
  diagnostics: readonly CheckDiagnostic[]
): string {
  const lines = ["Native shaders: invalid"];
  for (const diagnostic of diagnostics) {
    lines.push(
      `[${diagnostic.severity}] ${diagnostic.code} (${
        diagnostic.phase
      }): ${diagnostic.message.replace(/\r\n|\r|\n/gu, "\n  ")}`
    );
    if (diagnostic.location) {
      const { virtualPath, start } = diagnostic.location;
      lines.push(
        `  Resolved WGSL: ${virtualPath}:${start.line}:${start.column}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
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
