export const FACTORY_REPOSITORY = {
  id: 1_230_165_564,
  owner: "vercel-labs",
  name: "vgpu",
} as const;

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";
export const DEFAULT_FACTORY_MODEL = "anthropic/claude-sonnet-5";

export const FACTORY_LIMITS = {
  issueBodyCharacters: 16_000,
  duplicateBodyCharacters: 2_000,
  labelDescriptionCharacters: 100,
  labels: 100,
  duplicateCandidates: 5,
  duplicateSearchTerms: 8,
  githubResponseBytes: 1_000_000,
  fixtureBytes: 512_000,
  githubRequestTimeoutMs: 10_000,
  agentTurnTimeoutMs: 180_000,
  eveStartupTimeoutMs: 30_000,
} as const;

export const SECURITY_SUBAGENT_NAME = "issue_security_triager";

export const DISABLED_EVE_TOOLS = [
  "agent",
  "ask_question",
  "bash",
  "glob",
  "grep",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
] as const;
