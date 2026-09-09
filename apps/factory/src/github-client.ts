import { z } from "zod";
import {
  DuplicateCandidateSchema,
  LabelContextSchema,
  NormalizedTriageInputSchema,
  type NormalizedTriageInput,
} from "../agent/lib/triage-schema.ts";
import {
  FACTORY_LIMITS,
  FACTORY_REPOSITORY,
  GITHUB_API_ORIGIN,
  GITHUB_WEB_ORIGIN,
} from "./constants.ts";
import { FactoryRuntimeError } from "./errors.ts";

const githubUserSchema = z.object({ login: z.string() }).passthrough();
const FACTORY_REPOSITORY_FULL_NAME = `${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}`;
const githubRepositoryIdentitySchema = z
  .object({
    id: z.literal(FACTORY_REPOSITORY.id),
    owner: z
      .object({ login: z.literal(FACTORY_REPOSITORY.owner) })
      .passthrough(),
    name: z.literal(FACTORY_REPOSITORY.name),
    full_name: z.literal(FACTORY_REPOSITORY_FULL_NAME),
  })
  .passthrough();
const githubLabelSchema = z.union([
  z.string(),
  z
    .object({ name: z.string(), description: z.string().nullable().optional() })
    .passthrough(),
]);
const githubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    title: z.string(),
    body: z.string().nullable(),
    user: githubUserSchema.nullable(),
    created_at: z.string(),
    labels: z.array(githubLabelSchema),
    state: z.enum(["open", "closed"]),
    pull_request: z.unknown().optional(),
  })
  .passthrough();

const githubRepositoryLabelSchema = z
  .object({ name: z.string(), description: z.string().nullable() })
  .passthrough();
const githubSearchSchema = z
  .object({ items: z.array(githubIssueSchema) })
  .passthrough();

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "not",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "when",
  "with",
]);

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface GitHubClientOptions {
  readonly fetch?: FetchLike;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly responseByteLimit?: number;
}

export function truncateText(value: string, maximumCharacters: number): string {
  // Zod's string length constraints use JavaScript UTF-16 code units. Bound
  // with the same unit while avoiding a dangling high surrogate at the cut.
  if (value.length <= maximumCharacters) {
    return value;
  }
  if (maximumCharacters <= 0) return "";

  let prefix = value.slice(0, maximumCharacters - 1);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}…`;
}

export function buildDuplicateSearchTerms(title: string): string[] {
  const tokens = title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu);

  if (tokens === null) {
    return [];
  }

  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const bounded = Array.from(token).slice(0, 40).join("");
    if (
      bounded.length < 3 ||
      SEARCH_STOP_WORDS.has(bounded) ||
      seen.has(bounded)
    ) {
      continue;
    }

    seen.add(bounded);
    terms.push(bounded);
    if (terms.length === FACTORY_LIMITS.duplicateSearchTerms) {
      break;
    }
  }

  return terms;
}

export function buildDuplicateSearchQuery(title: string): string | null {
  const terms = buildDuplicateSearchTerms(title);
  if (terms.length === 0) {
    return null;
  }
  return `repo:${FACTORY_REPOSITORY.owner}/${
    FACTORY_REPOSITORY.name
  } is:issue in:title ${terms.join(" ")}`;
}

export type AllowedGitHubEndpoint =
  | "repository"
  | "issue"
  | "labels"
  | "search";

export function assertAllowedGitHubRequest(
  urlValue: string | URL,
  init: RequestInit = {}
): AllowedGitHubEndpoint {
  const url = new URL(urlValue);
  const method = (init.method ?? "GET").toUpperCase();

  if (method !== "GET") {
    throw new FactoryRuntimeError(
      `Blocked non-GET GitHub API request (${method}).`
    );
  }
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new FactoryRuntimeError(
      "Blocked GitHub request outside the api.github.com allowlist."
    );
  }

  const repositoryPath = `/repos/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}`;
  if (url.pathname === repositoryPath) {
    if (url.search === "") {
      return "repository";
    }
    throw new FactoryRuntimeError(
      "Blocked GitHub repository request with unexpected query parameters."
    );
  }

  const issuePattern = new RegExp(
    `^/repos/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}/issues/[1-9]\\d*$`,
    "u"
  );
  if (issuePattern.test(url.pathname) && url.search === "") {
    return "issue";
  }

  if (
    url.pathname ===
    `/repos/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}/labels`
  ) {
    if (
      url.searchParams.size === 1 &&
      url.searchParams.get("per_page") === String(FACTORY_LIMITS.labels)
    ) {
      return "labels";
    }
    throw new FactoryRuntimeError(
      "Blocked GitHub labels request with unexpected query parameters."
    );
  }

  if (url.pathname === "/search/issues") {
    const expectedPrefix = `repo:${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name} is:issue in:title `;
    const query = url.searchParams.get("q");
    if (
      url.searchParams.size === 2 &&
      url.searchParams.get("per_page") ===
        String(FACTORY_LIMITS.duplicateCandidates) &&
      query?.startsWith(expectedPrefix) === true &&
      buildDuplicateSearchTerms(query.slice(expectedPrefix.length)).join(
        " "
      ) === query.slice(expectedPrefix.length)
    ) {
      return "search";
    }
    throw new FactoryRuntimeError(
      "Blocked GitHub search request with unexpected query parameters."
    );
  }

  throw new FactoryRuntimeError(
    "Blocked GitHub request outside the endpoint allowlist."
  );
}

function issueWebUrl(issueNumber: number): string {
  return `${GITHUB_WEB_ORIGIN}/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}/issues/${issueNumber}`;
}

function validateIssueWebUrl(url: string, issueNumber: number): string {
  const expected = issueWebUrl(issueNumber);
  if (url !== expected) {
    throw new FactoryRuntimeError(
      `GitHub returned an unexpected issue URL for #${issueNumber}.`
    );
  }
  return url;
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new FactoryRuntimeError(
      "GitHub API response exceeded the configured size limit."
    );
  }

  if (response.body === null) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel("response-size-limit");
        throw new FactoryRuntimeError(
          "GitHub API response exceeded the configured size limit."
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new FactoryRuntimeError("GitHub API returned malformed JSON.", {
      cause: error,
    });
  }
}

function githubErrorMessage(
  endpoint: AllowedGitHubEndpoint,
  response: Response
): string {
  const requestName =
    endpoint === "repository"
      ? "repository identity"
      : endpoint === "issue"
      ? "issue"
      : endpoint === "labels"
      ? "label catalog"
      : "duplicate search";
  return `GitHub ${requestName} request failed with HTTP ${response.status}.`;
}

async function githubGet(
  url: URL,
  endpoint: AllowedGitHubEndpoint,
  options: Required<
    Pick<GitHubClientOptions, "fetch" | "timeoutMs" | "responseByteLimit">
  > &
    Pick<GitHubClientOptions, "token">
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "vgpu-factory",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (options.token?.trim()) {
    headers.Authorization = `Bearer ${options.token.trim()}`;
  }

  const init: RequestInit = {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  };
  const allowedEndpoint = assertAllowedGitHubRequest(url, init);
  if (allowedEndpoint !== endpoint) {
    throw new FactoryRuntimeError(
      "GitHub request did not match its expected endpoint."
    );
  }

  let response: Response;
  try {
    response = await options.fetch(url, init);
  } catch (error) {
    throw new FactoryRuntimeError(
      `GitHub ${endpoint} request failed before receiving a response.`,
      { cause: error }
    );
  }

  if (!response.ok) {
    throw new FactoryRuntimeError(githubErrorMessage(endpoint, response));
  }
  return readBoundedJson(response, options.responseByteLimit);
}

function labelsFromIssue(
  labels: readonly z.infer<typeof githubLabelSchema>[]
): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .map((label) => truncateText(label, 50))
    .filter(
      (label, index, all) => label.length > 0 && all.indexOf(label) === index
    )
    .slice(0, 30);
}

export async function fetchGitHubIssueContext(
  issueNumber: number,
  clientOptions: GitHubClientOptions = {}
): Promise<NormalizedTriageInput> {
  const options = {
    fetch: clientOptions.fetch ?? globalThis.fetch,
    timeoutMs: clientOptions.timeoutMs ?? FACTORY_LIMITS.githubRequestTimeoutMs,
    responseByteLimit:
      clientOptions.responseByteLimit ?? FACTORY_LIMITS.githubResponseBytes,
    token: clientOptions.token,
  };
  const repositoryApiUrl = new URL(
    `/repos/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}`,
    GITHUB_API_ORIGIN
  );
  const repositoryIdentity = githubRepositoryIdentitySchema.safeParse(
    await githubGet(repositoryApiUrl, "repository", options)
  );
  if (!repositoryIdentity.success) {
    throw new FactoryRuntimeError(
      "GitHub repository identity verification failed."
    );
  }

  const issueApiUrl = new URL(
    `/repos/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}/issues/${issueNumber}`,
    GITHUB_API_ORIGIN
  );
  const rawIssue = githubIssueSchema.parse(
    await githubGet(issueApiUrl, "issue", options)
  );
  if (rawIssue.pull_request !== undefined) {
    throw new FactoryRuntimeError(
      `#${issueNumber} is a pull request, not an issue.`
    );
  }
  if (rawIssue.number !== issueNumber) {
    throw new FactoryRuntimeError(
      `GitHub returned issue #${rawIssue.number} when #${issueNumber} was requested.`
    );
  }

  const issue = {
    number: rawIssue.number,
    url: validateIssueWebUrl(rawIssue.html_url, rawIssue.number),
    sourceId: `issue:${rawIssue.number}`,
    title: truncateText(rawIssue.title, 256),
    body: truncateText(rawIssue.body ?? "", FACTORY_LIMITS.issueBodyCharacters),
    author: rawIssue.user?.login ?? null,
    createdAt: rawIssue.created_at,
    labels: labelsFromIssue(rawIssue.labels),
  };

  const labelsUrl = new URL(
    `/repos/${FACTORY_REPOSITORY.owner}/${FACTORY_REPOSITORY.name}/labels`,
    GITHUB_API_ORIGIN
  );
  labelsUrl.searchParams.set("per_page", String(FACTORY_LIMITS.labels));

  const searchQuery = buildDuplicateSearchQuery(issue.title);
  const labelsPromise = githubGet(labelsUrl, "labels", options)
    .then((value) =>
      z
        .array(githubRepositoryLabelSchema)
        .max(FACTORY_LIMITS.labels)
        .parse(value)
    )
    .then((labels) =>
      labels.map((label) =>
        LabelContextSchema.parse({
          name: truncateText(label.name, 50),
          description:
            label.description === null
              ? null
              : truncateText(
                  label.description,
                  FACTORY_LIMITS.labelDescriptionCharacters
                ),
        })
      )
    );
  const searchPromise =
    searchQuery === null
      ? null
      : (() => {
          const url = new URL("/search/issues", GITHUB_API_ORIGIN);
          url.searchParams.set("q", searchQuery);
          url.searchParams.set(
            "per_page",
            String(FACTORY_LIMITS.duplicateCandidates)
          );
          return githubGet(url, "search", options)
            .then((value) => githubSearchSchema.parse(value))
            .then((search) =>
              search.items
                .filter(
                  (candidate) =>
                    candidate.pull_request === undefined &&
                    candidate.number !== issue.number
                )
                .slice(0, FACTORY_LIMITS.duplicateCandidates)
                .map((candidate) =>
                  DuplicateCandidateSchema.parse({
                    number: candidate.number,
                    url: validateIssueWebUrl(
                      candidate.html_url,
                      candidate.number
                    ),
                    sourceId: `duplicate:${candidate.number}`,
                    title: truncateText(candidate.title, 256),
                    bodyExcerpt: truncateText(
                      candidate.body ?? "",
                      FACTORY_LIMITS.duplicateBodyCharacters
                    ),
                    state: candidate.state,
                  })
                )
            );
        })();

  const [labelsResult, searchResult] = await Promise.all([
    labelsPromise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    ),
    searchPromise === null
      ? Promise.resolve({ status: "skipped" as const })
      : searchPromise.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason })
        ),
  ]);

  const contextWarnings: string[] = [];
  const labelsAvailable = labelsResult.status === "fulfilled";
  if (!labelsAvailable) {
    contextWarnings.push(
      "GitHub label catalog unavailable; label recommendations are disabled."
    );
  }

  const duplicateSearchAvailable = searchResult.status === "fulfilled";
  if (searchResult.status === "skipped") {
    contextWarnings.push(
      "Duplicate search skipped because the issue title has no meaningful search terms."
    );
  } else if (searchResult.status === "rejected") {
    contextWarnings.push(
      "GitHub duplicate search unavailable; duplicate recommendations are disabled."
    );
  }

  const availableLabels =
    labelsResult.status === "fulfilled" ? labelsResult.value : [];

  const duplicateCandidates =
    searchResult.status === "fulfilled" ? searchResult.value : [];

  return NormalizedTriageInputSchema.parse({
    schemaVersion: 1,
    repository: FACTORY_REPOSITORY,
    issue,
    duplicateCandidates,
    availableLabels,
    contextWarnings,
    availableSourceIds: [
      issue.sourceId,
      ...duplicateCandidates.map((candidate) => candidate.sourceId),
    ],
    capabilities: { labelsAvailable, duplicateSearchAvailable },
  });
}
