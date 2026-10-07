import { agent, claudeCode } from "subharness";
import { prWritingGuide } from "../tools/pr-writing.js";
import { repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "pr-writer",
  description:
    "Drafts Markdown-first PR titles and descriptions: an explicit before/problem walkthrough, an after/solution walkthrough and native code blocks, followed by an evidence-backed technical record. Adds images only for complex diagrams that need a drawn representation. Writes only assigned PR scratch artifacts; the lead publishes.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${prWritingGuide}

Do not delegate. Write only under the PR artifact directory supplied by the lead (default .context/work/<topic>/pr/). Never edit repository source, docs, tests, agent definitions, generated artifacts or release records. Do not stage, commit, upload attachments, create/edit a GitHub PR or comment, push, merge, or change authentication. The lead reviews and publishes the result within the user's authorization. Read-only GitHub queries are allowed when needed. Do not rerun expensive implementation suites to compose a description; use revision-specific evidence and report gaps.`,
  harness: claudeCode({
    model: "claude-sonnet-5.5",
    effort: "high",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
  }),
});
