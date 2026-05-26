import { catCommand } from "./commands/cat.js";
import { findCommand } from "./commands/find.js";
import { grepCommand } from "./commands/grep.js";
import { lsCommand } from "./commands/ls.js";
import { pathCommand } from "./commands/path.js";
import { fail, ok } from "./commands/shared.js";
import { symbolsCommand } from "./commands/symbols.js";
import { docsHelp } from "./help.js";
import { buildIndex } from "./index.js";

export function runDocs(args) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") return ok(docsHelp);
  const index = buildIndex();
  switch (command) {
    case "ls": return lsCommand(index, rest);
    case "cat": return catCommand(index, rest);
    case "grep": return grepCommand(index, rest);
    case "find": return findCommand(index, rest);
    case "path": return pathCommand(index, rest);
    case "symbols": return symbolsCommand(index, rest);
    default: return fail(`Unknown docs command: ${command}\n\n${docsHelp}`);
  }
}
