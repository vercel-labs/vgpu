import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Own host selections synchronously; relative paths belong to this invocation's cwd. */
export function captureToolEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Readonly<NodeJS.ProcessEnv> {
  const owned = { ...environment };
  owned.TMPDIR = resolve(owned.TMPDIR ?? tmpdir());
  if (owned.DEVELOPER_DIR !== undefined)
    owned.DEVELOPER_DIR = resolve(owned.DEVELOPER_DIR);
  return Object.freeze(owned);
}
