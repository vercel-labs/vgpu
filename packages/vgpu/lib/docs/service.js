import { findDocs } from "./commands/find.js";
import { grepDocs } from "./commands/grep.js";
import { listDocs } from "./commands/ls.js";
import { resolveDocsTarget } from "./commands/resolve.js";
import { listDocSymbols } from "./commands/symbols.js";
import { DocsError } from "./errors.js";
import { buildIndex, normalizePath } from "./index.js";

export function createDocsService(index = buildIndex()) {
  return {
    execute(input) {
      if (input.operation === "read" || input.operation === "resolve") {
        const resolved = resolveOne(index, input.target);
        if (input.operation === "resolve") {
          return {
            operation: "resolve",
            target: input.target,
            ...recordMetadata(resolved),
          };
        }
        return {
          operation: "read",
          document: {
            ...recordMetadata(resolved),
            summary: resolved.summary,
            content: resolved.content.trimEnd(),
          },
        };
      }
      if (input.operation === "list") {
        const path = normalizePath(input.path ?? "/");
        const entries = listDocs(index, path);
        if (!entries) {
          throw new DocsError("VGPU-DOCS-NOT-FOUND", `Path not found: ${path}`, {
            target: path,
            lookup: "path",
          });
        }
        return {
          operation: "list",
          path,
          entries,
        };
      }
      if (input.operation === "grep") {
        const matches = grepDocs(index, {
          pattern: input.pattern,
          ignoreCase: input.ignoreCase,
          packageName: input.package,
        });
        if (matches.length === 0) {
          throw new DocsError("VGPU-DOCS-NOT-FOUND", `No matches for: ${input.pattern}`, {
            pattern: input.pattern,
          });
        }
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        return {
          operation: "grep",
          pattern: input.pattern,
          truncated: matches.length > limit,
          matches: matches.slice(0, limit),
        };
      }
      if (input.operation === "symbols") {
        const query = input.query?.toLowerCase();
        const symbols = listDocSymbols(index)
          .filter((symbol) => !input.package || matchesPackage(symbol.package, input.package))
          .filter((symbol) => !query || Object.values(symbol).some((value) => value.toLowerCase().includes(query)));
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        return {
          operation: "symbols",
          truncated: symbols.length > limit,
          symbols: symbols.slice(0, limit),
        };
      }
      if (input.operation !== "search") throw new Error(`Unsupported docs operation: ${input.operation}`);
      const found = findDocs(index, input.query);
      if (found.results.length === 0) {
        throw new DocsError("VGPU-DOCS-NOT-FOUND", `No docs found for: ${input.query}`, {
          query: input.query,
        });
      }
      return {
        operation: "search",
        truncated: found.truncated,
        results: found.results,
      };
    },
  };
}

function matchesPackage(recordPackage, filter) {
  return recordPackage === filter || recordPackage.startsWith(`${filter}/`);
}

function resolveOne(index, target) {
  const { resolved, lookup } = resolveDocsTarget(index, target);
  if (!resolved) {
    const kind = lookup === "path" ? "Path" : "Symbol";
    throw new DocsError("VGPU-DOCS-NOT-FOUND", `${kind} not found: ${target}`, { target, lookup });
  }
  if (Array.isArray(resolved)) {
    throw new DocsError("VGPU-DOCS-AMBIGUOUS", `Ambiguous symbol: ${target}`, {
      target,
      candidates: resolved.map(recordMetadata),
    });
  }
  return resolved;
}

function recordMetadata(record) {
  return {
    symbol: record.symbol,
    package: record.package,
    virtualPath: record.virtualPath,
    repoPath: record.repoPath,
    kind: record.kind,
  };
}
