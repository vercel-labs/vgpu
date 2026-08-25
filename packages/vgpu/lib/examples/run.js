import { examplesHelp } from "./help.js";
import { ExamplesClient } from "./client.js";
import { ExamplesCache, cacheRoot } from "./cache.js";
import { createExamplesService } from "./service.js";
import { tokens } from "./search.js";
import { pullExample } from "./pull.js";
import { errorResult, usage } from "./errors.js";

const SHA = /^[a-f0-9]{64}$/;
const json = (value, pretty) => `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;

function parse(command, args) {
  const positional = [];
  const options = {};
  const allowed = {
    search: new Set(["any", "limit", "revision", "offline", "pretty", "base-url"]),
    show: new Set(["revision", "offline", "pretty", "base-url"]),
    cat: new Set(["revision", "offline", "json", "base-url"]),
    pull: new Set(["out", "revision", "offline", "force", "pretty", "base-url"]),
  }[command];
  if (!allowed) throw usage(`Unknown examples command: ${command}`);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (!allowed.has(key) || Object.hasOwn(options, key)) throw usage(`Invalid or duplicate option: ${argument}`);
    if (["limit", "revision", "out", "base-url"].includes(key)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw usage(`Option ${argument} requires a value`);
      options[key] = args[++index];
    } else {
      options[key] = true;
    }
  }
  return { positional, options };
}

export async function runExamples(
  args,
  { version = "0.0.0", env = process.env, fetchImpl = fetch, now = () => new Date(), platform = process.platform } = {},
) {
  let warnings = "";
  try {
    const [command, ...rest] = args;
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      return { code: 0, stdout: examplesHelp };
    }
    if (command === "cache") {
      if (rest.length !== 1 || !["path", "clear"].includes(rest[0])) throw usage("Usage: vgpu examples cache path|clear");
      const cache = new ExamplesCache(cacheRoot(env), { platform });
      const path = cache.memory ? "memory" : cache.root;
      if (rest[0] === "path") return { code: 0, stdout: `${path}\n` };
      await cache.clear();
      return { code: 0, stdout: json({ cleared: true, path }, false) };
    }

    const { positional, options } = parse(command, rest);
    const counts = { search: 1, show: 1, cat: 2, pull: 1 };
    if (positional.length !== counts[command]) throw usage(`Invalid arguments for examples ${command}`);
    if (options.revision && !SHA.test(options.revision)) throw usage("--revision must be a lowercase SHA-256");
    if (options.limit !== undefined && (!/^\d+$/.test(options.limit) || +options.limit < 1 || +options.limit > 100)) {
      throw usage("--limit must be an integer from 1 to 100");
    }
    if (command === "pull" && !options.out) throw usage("pull requires --out <directory>");
    if (command === "search" && !tokens(positional[0]).length) throw usage("Search query must contain a letter or number");

    const client = new ExamplesClient({
      baseUrl: options["base-url"] || env.VGPU_EXAMPLES_BASE_URL || "https://vgpu.sh",
      fetchImpl,
      cache: new ExamplesCache(cacheRoot(env), { platform }),
      cliVersion: version,
      now,
      warn: (warning) => { warnings += warning; },
    });
    const common = { revision: options.revision, offline: !!options.offline };

    if (command === "pull") {
      const state = await client.getIndex(common);
      const manifest = await client.getManifest(state.index, positional[0], { offline: common.offline });
      const result = await pullExample(client, manifest, options.out, {
        force: !!options.force,
        offline: common.offline,
        platform,
      });
      const value = {
        revision: manifest.revision,
        id: manifest.id,
        ...result,
        aggregateSha256: manifest.aggregateSha256,
        ...(state.offline ? { lastVerifiedAt: state.lastVerifiedAt } : {}),
      };
      return { code: 0, stdout: json(value, !!options.pretty), ...(warnings ? { stderr: warnings } : {}) };
    }

    const examples = createExamplesService({ source: client });
    if (command === "search") {
      const { operation: _operation, ...value } = await examples.execute({
        operation: "search",
        query: positional[0],
        match: options.any ? "any" : "all",
        limit: options.limit ? +options.limit : 20,
        ...common,
      });
      return { code: 0, stdout: json(value, !!options.pretty), ...(warnings ? { stderr: warnings } : {}) };
    }
    if (command === "show") {
      const result = await examples.execute({ operation: "show", id: positional[0], ...common });
      const value = { ...result.manifest, ...(result.lastVerifiedAt ? { lastVerifiedAt: result.lastVerifiedAt } : {}) };
      return { code: 0, stdout: json(value, !!options.pretty), ...(warnings ? { stderr: warnings } : {}) };
    }

    const result = await examples.execute({ operation: "read", id: positional[0], path: positional[1], ...common });
    if (!options.json) return { code: 0, stdout: Buffer.from(result.content), ...(warnings ? { stderr: warnings } : {}) };
    const { operation: _operation, contentType: _contentType, ...value } = result;
    return { code: 0, stdout: json(value, false), ...(warnings ? { stderr: warnings } : {}) };
  } catch (error) {
    return errorResult(error);
  }
}
