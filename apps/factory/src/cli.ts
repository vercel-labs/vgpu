import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NormalizedTriageInput,
  TriageReport,
} from "../agent/lib/triage-schema.ts";
import {
  assertSupportedNodeVersion,
  parseFactoryArguments,
} from "./cli-arguments.ts";
import {
  buildSanitizedEveEnvironment,
  type SanitizedEveEnvironment,
} from "./environment.ts";
import { displayError, exitCodeForError } from "./errors.ts";
import { loadTriageFixture } from "./fixture-loader.ts";
import { fetchGitHubIssueContext } from "./github-client.ts";
import { runTriageAgent } from "./eve-runner.ts";

const DEFAULT_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_APP_ROOT, "../..");

export interface FactoryCliDependencies {
  readonly appRoot?: string;
  readonly repositoryRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nodeVersion?: string;
  readonly buildEnvironment?: (options: {
    appRoot: string;
    hostEnvironment: NodeJS.ProcessEnv;
  }) => Promise<SanitizedEveEnvironment>;
  readonly fetchIssueContext?: (
    issueNumber: number,
    options: { token?: string }
  ) => Promise<NormalizedTriageInput>;
  readonly loadFixture?: (
    fixturePath: string,
    options: { repositoryRoot: string }
  ) => Promise<NormalizedTriageInput>;
  readonly runAgent?: (
    context: NormalizedTriageInput,
    options: { appRoot: string; environment: NodeJS.ProcessEnv }
  ) => Promise<TriageReport>;
  readonly stdout?: { write(value: string): unknown };
  readonly stderr?: { write(value: string): unknown };
}

function terminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu,
    "�"
  );
}

function terminalInline(value: string): string {
  return terminalText(value).replaceAll("\n", " ↩ ");
}

function terminalBlock(value: string): string {
  return terminalText(value)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function renderHumanReport(report: TriageReport): string {
  const lines = [
    `DRY RUN — ${report.repository.owner}/${report.repository.name}#${report.issue.number}`,
    `Classification: ${report.classification} (${report.confidence} confidence)`,
    `Disposition: ${report.disposition}`,
    `Security: ${report.security.verdict} — ${terminalInline(
      report.security.reason
    )}`,
    "",
    "Summary:",
    terminalBlock(report.summary),
  ];

  if (report.security.signals.length > 0) {
    lines.push(
      "",
      "Security signals:",
      ...report.security.signals.map((signal) => `- ${terminalInline(signal)}`)
    );
  }
  if (report.contextWarnings.length > 0) {
    lines.push(
      "",
      "Context warnings:",
      ...report.contextWarnings.map((warning) => `- ${terminalInline(warning)}`)
    );
  }
  lines.push(
    "",
    "Evidence:",
    ...report.evidence.map(
      (evidence) =>
        `- [${evidence.sourceId}] ${terminalInline(evidence.statement)}`
    )
  );
  if (report.missingInformation.length > 0) {
    lines.push(
      "",
      "Missing information:",
      ...report.missingInformation.map((item) => `- ${terminalInline(item)}`)
    );
  }
  if (report.duplicateOf !== null) {
    lines.push(
      "",
      `Candidate duplicate: #${report.duplicateOf.number} (${report.duplicateOf.url})`
    );
  }
  if (report.proposedLabels.length > 0) {
    lines.push(
      "",
      `Proposed labels: ${report.proposedLabels.map(terminalInline).join(", ")}`
    );
  }
  if (report.draftReply !== null) {
    lines.push("", "Draft reply:", terminalBlock(report.draftReply));
  }
  lines.push("", "No GitHub changes were made.");
  return `${lines.join("\n")}\n`;
}

export function renderJsonReport(report: TriageReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function runFactoryCli(
  argv: readonly string[],
  dependencies: FactoryCliDependencies = {}
): Promise<number> {
  const appRoot = dependencies.appRoot ?? DEFAULT_APP_ROOT;
  const repositoryRoot = dependencies.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  const environment = dependencies.environment ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;

  const arguments_ = parseFactoryArguments(argv);
  assertSupportedNodeVersion(dependencies.nodeVersion ?? process.versions.node);

  const sanitizedEnvironment = await (
    dependencies.buildEnvironment ?? buildSanitizedEveEnvironment
  )({
    appRoot,
    hostEnvironment: environment,
  });

  const context =
    arguments_.issueNumber === undefined
      ? await (dependencies.loadFixture ?? loadTriageFixture)(
          arguments_.fixturePath,
          { repositoryRoot }
        )
      : await (dependencies.fetchIssueContext ?? fetchGitHubIssueContext)(
          arguments_.issueNumber,
          {
            token: sanitizedEnvironment.githubToken,
          }
        );

  const report = await (dependencies.runAgent ?? runTriageAgent)(context, {
    appRoot,
    environment: sanitizedEnvironment.environment,
  });
  stdout.write(
    arguments_.json ? renderJsonReport(report) : renderHumanReport(report)
  );
  return 0;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: FactoryCliDependencies = {}
): Promise<number> {
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    return await runFactoryCli(argv, dependencies);
  } catch (error) {
    stderr.write(`factory: ${terminalText(displayError(error))}\n`);
    return exitCodeForError(error);
  }
}
