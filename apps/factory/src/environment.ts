import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { DEFAULT_FACTORY_MODEL } from "./constants.ts";
import { FactoryConfigurationError } from "./errors.ts";

const DOTENV_FILES = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
] as const;
const OS_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
] as const;
const FACTORY_ENVIRONMENT_KEYS = new Set([
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VGPU_FACTORY_MODEL",
]);

export interface EnvironmentFileReader {
  (path: string, encoding: BufferEncoding): Promise<string>;
}

export interface SanitizedEveEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly credentialKind: "AI_GATEWAY_API_KEY" | "VERCEL_OIDC_TOKEN";
  readonly model: string;
  /** Optional token for the trusted host-side GitHub adapter; never forwarded to Eve. */
  readonly githubToken?: string;
}

async function readEnvironmentFiles(
  appRoot: string,
  readEnvironmentFile: EnvironmentFileReader
): Promise<Map<string, string>> {
  const values = new Map<string, string>();

  for (const filename of DOTENV_FILES) {
    let source: string;
    try {
      source = await readEnvironmentFile(resolve(appRoot, filename), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new FactoryConfigurationError(
        `Unable to safely inspect ${filename}.`,
        { cause: error }
      );
    }

    let parsed: NodeJS.Dict<string>;
    try {
      parsed = parseEnv(source);
    } catch (error) {
      throw new FactoryConfigurationError(
        `Unable to safely parse ${filename}.`,
        { cause: error }
      );
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!values.has(key) && value !== undefined) {
        values.set(key, value);
      }
    }
  }

  return values;
}

function nonempty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

export async function buildSanitizedEveEnvironment(options: {
  readonly appRoot: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly readEnvironmentFile?: EnvironmentFileReader;
}): Promise<SanitizedEveEnvironment> {
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const environmentFileValues = await readEnvironmentFiles(
    options.appRoot,
    options.readEnvironmentFile ?? readFile
  );
  const configuredValue = (key: string): string | undefined =>
    nonempty(hostEnvironment[key]) ?? nonempty(environmentFileValues.get(key));

  const apiGatewayKey = configuredValue("AI_GATEWAY_API_KEY");
  const oidcToken = configuredValue("VERCEL_OIDC_TOKEN");
  if (apiGatewayKey === undefined && oidcToken === undefined) {
    throw new FactoryConfigurationError(
      "Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN before running factory triage."
    );
  }

  const environment: NodeJS.ProcessEnv = {};
  for (const key of environmentFileValues.keys()) {
    environment[key] = "";
  }
  for (const key of OS_ENVIRONMENT_KEYS) {
    if (hostEnvironment[key] !== undefined) {
      environment[key] = hostEnvironment[key];
    }
  }

  // These are always seeded so eve's dotenv loader cannot reintroduce GitHub
  // credentials into the agent process, even when an app-local env file has one.
  environment.GITHUB_TOKEN = "";
  environment.GH_TOKEN = "";
  // Eve's zero-config local traces retain model prompts, responses, and tool
  // inputs by default. Preserve trace metadata for debugging, but never spool
  // issue or security-report content to disk from this read-only runner.
  environment.EVE_TRACES_CONTENT = "off";
  environment.NODE_ENV = "development";
  environment.NO_COLOR = "1";

  let credentialKind: SanitizedEveEnvironment["credentialKind"];
  if (apiGatewayKey !== undefined) {
    credentialKind = "AI_GATEWAY_API_KEY";
    environment.AI_GATEWAY_API_KEY = apiGatewayKey;
    environment.VERCEL_OIDC_TOKEN = "";
  } else {
    credentialKind = "VERCEL_OIDC_TOKEN";
    environment.AI_GATEWAY_API_KEY = "";
    environment.VERCEL_OIDC_TOKEN = oidcToken!;
  }

  const model = configuredValue("VGPU_FACTORY_MODEL") ?? DEFAULT_FACTORY_MODEL;
  environment.VGPU_FACTORY_MODEL = model;
  const githubToken = configuredValue("GITHUB_TOKEN");

  // Make the allowlist auditable: every non-OS nonempty value must be one of
  // the selected runtime credential, the model, or a fixed runner flag above.
  for (const [key, value] of Object.entries(environment)) {
    if (
      value &&
      !OS_ENVIRONMENT_KEYS.includes(
        key as (typeof OS_ENVIRONMENT_KEYS)[number]
      ) &&
      !FACTORY_ENVIRONMENT_KEYS.has(key) &&
      key !== "EVE_TRACES_CONTENT" &&
      key !== "NODE_ENV" &&
      key !== "NO_COLOR"
    ) {
      throw new FactoryConfigurationError(
        `Refused to forward non-allowlisted environment variable ${key}.`
      );
    }
  }

  return {
    environment,
    credentialKind,
    model,
    ...(githubToken === undefined ? {} : { githubToken }),
  };
}
