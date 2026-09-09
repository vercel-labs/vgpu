import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  NormalizedTriageInputSchema,
  type NormalizedTriageInput,
} from "../agent/lib/triage-schema.ts";
import {
  FACTORY_LIMITS,
  FACTORY_REPOSITORY,
  GITHUB_WEB_ORIGIN,
} from "./constants.ts";
import { FactoryUsageError } from "./errors.ts";

export interface FixtureFileSystem {
  readonly readFile: (
    path: string,
    encoding: BufferEncoding
  ) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<{ isFile(): boolean; size: number }>;
}

const defaultFileSystem: FixtureFileSystem = { readFile, realpath, stat };

function isContainedPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function expectedIssueUrl(issueNumber: number): string {
  return `${GITHUB_WEB_ORIGIN}/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}/issues/${issueNumber}`;
}

export function validateNormalizedContext(
  context: NormalizedTriageInput
): NormalizedTriageInput {
  if (
    context.repository.id !== FACTORY_REPOSITORY.id ||
    context.repository.owner !== FACTORY_REPOSITORY.owner ||
    context.repository.name !== FACTORY_REPOSITORY.name
  ) {
    throw new FactoryUsageError(
      "Fixture repository must be vercel-labs/vgpu with repository ID 1230165564."
    );
  }

  if (context.issue.url !== expectedIssueUrl(context.issue.number)) {
    throw new FactoryUsageError(
      "Fixture issue URL does not match its vercel-labs/vgpu issue number."
    );
  }

  const sourceIds = [
    context.issue.sourceId,
    ...context.duplicateCandidates.map((candidate) => candidate.sourceId),
  ];
  const sourceIdSet = new Set(sourceIds);
  if (sourceIdSet.size !== sourceIds.length) {
    throw new FactoryUsageError("Fixture source IDs must be unique.");
  }
  if (
    context.availableSourceIds.length !== sourceIds.length ||
    context.availableSourceIds.some((sourceId) => !sourceIdSet.has(sourceId))
  ) {
    throw new FactoryUsageError(
      "Fixture availableSourceIds must exactly list the issue and duplicate candidate source IDs."
    );
  }

  for (const candidate of context.duplicateCandidates) {
    if (candidate.url !== expectedIssueUrl(candidate.number)) {
      throw new FactoryUsageError(
        `Fixture duplicate #${candidate.number} has an unexpected URL.`
      );
    }
    if (candidate.number === context.issue.number) {
      throw new FactoryUsageError(
        "Fixture cannot list the source issue as its own duplicate candidate."
      );
    }
  }

  if (
    !context.capabilities.labelsAvailable &&
    context.availableLabels.length > 0
  ) {
    throw new FactoryUsageError(
      "Fixture cannot provide labels when label context is marked unavailable."
    );
  }
  if (
    !context.capabilities.duplicateSearchAvailable &&
    context.duplicateCandidates.length > 0
  ) {
    throw new FactoryUsageError(
      "Fixture cannot provide duplicate candidates when duplicate search is marked unavailable."
    );
  }

  return context;
}

export async function loadTriageFixture(
  fixturePath: string,
  options: {
    readonly repositoryRoot: string;
    readonly fileSystem?: FixtureFileSystem;
  }
): Promise<NormalizedTriageInput> {
  if (
    fixturePath.length === 0 ||
    fixturePath.includes("\0") ||
    isAbsolute(fixturePath)
  ) {
    throw new FactoryUsageError(
      "Fixture path must be a non-empty repository-relative path."
    );
  }
  if (!fixturePath.toLocaleLowerCase("en-US").endsWith(".json")) {
    throw new FactoryUsageError("Fixture path must point to a JSON file.");
  }

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  let repositoryRealPath: string;
  let fixtureRealPath: string;
  try {
    repositoryRealPath = await fileSystem.realpath(options.repositoryRoot);
    fixtureRealPath = await fileSystem.realpath(
      resolve(repositoryRealPath, fixturePath)
    );
  } catch (error) {
    throw new FactoryUsageError(
      `Unable to resolve fixture path ${JSON.stringify(fixturePath)}.`,
      { cause: error }
    );
  }

  if (!isContainedPath(repositoryRealPath, fixtureRealPath)) {
    throw new FactoryUsageError(
      "Fixture path resolves outside the repository root."
    );
  }

  let fixtureStat: Awaited<ReturnType<FixtureFileSystem["stat"]>>;
  try {
    fixtureStat = await fileSystem.stat(fixtureRealPath);
  } catch (error) {
    throw new FactoryUsageError(
      `Unable to inspect fixture ${JSON.stringify(fixturePath)}.`,
      { cause: error }
    );
  }
  if (!fixtureStat.isFile()) {
    throw new FactoryUsageError("Fixture path must resolve to a regular file.");
  }
  if (fixtureStat.size > FACTORY_LIMITS.fixtureBytes) {
    throw new FactoryUsageError("Fixture exceeds the configured size limit.");
  }

  let parsed: unknown;
  try {
    const source = await fileSystem.readFile(fixtureRealPath, "utf8");
    if (Buffer.byteLength(source, "utf8") > FACTORY_LIMITS.fixtureBytes) {
      throw new FactoryUsageError("Fixture exceeds the configured size limit.");
    }
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof FactoryUsageError) {
      throw error;
    }
    throw new FactoryUsageError(
      `Fixture ${JSON.stringify(fixturePath)} is not valid JSON.`,
      { cause: error }
    );
  }

  try {
    return validateNormalizedContext(NormalizedTriageInputSchema.parse(parsed));
  } catch (error) {
    if (error instanceof FactoryUsageError) {
      throw error;
    }
    throw new FactoryUsageError(
      `Fixture ${JSON.stringify(
        fixturePath
      )} does not match the normalized triage schema.`,
      {
        cause: error,
      }
    );
  }
}
