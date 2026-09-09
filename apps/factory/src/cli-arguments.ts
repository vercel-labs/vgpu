import { FactoryConfigurationError, FactoryUsageError } from "./errors.ts";

export type FactoryCliArguments = Readonly<
  {
    command: "triage";
    dryRun: true;
    json: boolean;
  } & (
    | { issueNumber: number; fixturePath?: never }
    | { issueNumber?: never; fixturePath: string }
  )
>;

export const FACTORY_USAGE = `Usage:
  pnpm factory triage --issue <number> --dry-run [--json]
  pnpm factory triage --fixture <repo-relative.json> --dry-run [--json]`;

export function parseFactoryArguments(
  argv: readonly string[]
): FactoryCliArguments {
  if (argv.length === 0 || argv[0] !== "triage") {
    throw new FactoryUsageError(
      `Expected the \"triage\" command.\n\n${FACTORY_USAGE}`
    );
  }

  let issueNumber: number | undefined;
  let fixturePath: string | undefined;
  let dryRun = false;
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      if (dryRun) {
        throw new FactoryUsageError(
          'Option "--dry-run" may be provided only once.'
        );
      }
      dryRun = true;
      continue;
    }

    if (argument === "--json") {
      if (json) {
        throw new FactoryUsageError(
          'Option "--json" may be provided only once.'
        );
      }
      json = true;
      continue;
    }

    if (argument === "--issue") {
      if (issueNumber !== undefined) {
        throw new FactoryUsageError(
          'Option "--issue" may be provided only once.'
        );
      }

      const rawIssueNumber = argv[index + 1];
      if (rawIssueNumber === undefined || rawIssueNumber.startsWith("--")) {
        throw new FactoryUsageError(
          'Option "--issue" requires a positive integer.'
        );
      }
      if (!/^[1-9]\d*$/u.test(rawIssueNumber)) {
        throw new FactoryUsageError(
          'Option "--issue" requires a positive integer.'
        );
      }

      issueNumber = Number(rawIssueNumber);
      if (!Number.isSafeInteger(issueNumber)) {
        throw new FactoryUsageError(
          'Option "--issue" is outside the supported integer range.'
        );
      }
      index += 1;
      continue;
    }

    if (argument === "--fixture") {
      if (fixturePath !== undefined) {
        throw new FactoryUsageError(
          'Option "--fixture" may be provided only once.'
        );
      }

      const rawFixturePath = argv[index + 1];
      if (rawFixturePath === undefined || rawFixturePath.startsWith("--")) {
        throw new FactoryUsageError(
          'Option "--fixture" requires a repository-relative JSON path.'
        );
      }
      fixturePath = rawFixturePath;
      index += 1;
      continue;
    }

    if (argument === "--apply") {
      throw new FactoryUsageError(
        'Mutation mode is not implemented. Use the required "--dry-run" flag.'
      );
    }

    if (argument === "--repo" || argument.startsWith("--repo=")) {
      throw new FactoryUsageError(
        'The repository is fixed to "vercel-labs/vgpu"; "--repo" is not supported.'
      );
    }

    throw new FactoryUsageError(
      `Unknown argument: ${JSON.stringify(argument)}.\n\n${FACTORY_USAGE}`
    );
  }

  if (!dryRun) {
    throw new FactoryUsageError(
      'The explicit "--dry-run" safety flag is required.'
    );
  }

  if ((issueNumber === undefined) === (fixturePath === undefined)) {
    throw new FactoryUsageError(
      'Provide exactly one of "--issue" or "--fixture".'
    );
  }

  return issueNumber === undefined
    ? { command: "triage", dryRun: true, fixturePath: fixturePath!, json }
    : { command: "triage", dryRun: true, issueNumber, json };
}

export function assertSupportedNodeVersion(version: string): void {
  const majorText = version.split(".", 1)[0];
  const major = Number(majorText);
  if (!Number.isInteger(major) || major < 24) {
    throw new FactoryConfigurationError(
      `The factory requires Node.js 24 or newer; current version is ${JSON.stringify(
        version
      )}.`
    );
  }
}
