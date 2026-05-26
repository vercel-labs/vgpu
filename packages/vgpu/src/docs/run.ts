import { catCommand } from "./commands/cat.ts";
import { findCommand } from "./commands/find.ts";
import { grepCommand } from "./commands/grep.ts";
import { lsCommand } from "./commands/ls.ts";
import { pathCommand } from "./commands/path.ts";
import { fail, ok } from "./commands/shared.ts";
import { symbolsCommand } from "./commands/symbols.ts";
import { docsHelp } from "./help.ts";
import { buildIndex } from "./index.ts";
import type { CommandResult } from "./model.ts";

export function runDocs(args: string[]): CommandResult {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") return ok(docsHelp);
  const index = buildIndex();
  switch (command) {
    case "ls":
      return lsCommand(index, rest);
    case "cat":
      return catCommand(index, rest);
    case "grep":
      return grepCommand(index, rest);
    case "find":
      return findCommand(index, rest);
    case "path":
      return pathCommand(index, rest);
    case "symbols":
      return symbolsCommand(index, rest);
    default:
      return fail(`Unknown docs command: ${command}\n\n${docsHelp}`);
  }
}
