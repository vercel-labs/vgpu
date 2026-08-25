import { searchExamples } from "./search.js";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { destinationExists, filesystem, notFound, usage } from "./errors.js";
import { assertSafeRelativePath } from "./paths.js";

export function createExamplesService({
  source,
  downloadRoot = undefined,
  platform = process.platform,
  downloadExample = undefined,
}) {
  return {
    async execute(input, { signal } = {}) {
      signal?.throwIfAborted();
      let downloadPath;
      if (input.operation === "download") {
        if (!downloadExample) throw usage("Example download is unavailable on this transport");
        downloadPath = downloadDestination(downloadRoot, input.destination);
        await assertNewDownloadDestination(downloadRoot, input.destination, downloadPath);
      }
      const request = { offline: input.offline === true, signal };
      const state = await source.getIndex({ revision: input.revision, ...request });
      signal?.throwIfAborted();
      const offlineMetadata = state.offline && state.lastVerifiedAt
        ? { lastVerifiedAt: state.lastVerifiedAt }
        : {};
      if (input.operation === "search") {
        return {
          operation: "search",
          revision: state.index.revision,
          results: searchExamples(state.index, input.query, {
            any: input.match === "any",
            limit: input.limit ?? 20,
          }),
          ...offlineMetadata,
        };
      }
      if (!["show", "read", "download"].includes(input.operation)) {
        throw new Error(`Unsupported examples operation: ${input.operation}`);
      }
      const manifest = await source.getManifest(state.index, input.id, request);
      signal?.throwIfAborted();
      if (input.operation === "show") {
        return {
          operation: "show",
          manifest,
          ...offlineMetadata,
        };
      }
      if (input.operation === "read") {
        const path = assertSafeRelativePath(input.path);
        const file = manifest.files.find((candidate) => candidate.path === path);
        if (!file) throw notFound(`File not found: ${path}`);
        const bytes = await source.getFile(manifest, file, request);
        signal?.throwIfAborted();
        return {
          operation: "read",
          revision: manifest.revision,
          id: manifest.id,
          path: file.path,
          contentType: file.contentType,
          size: file.size,
          sha256: file.sha256,
          content: bytes.toString("utf8"),
        };
      }
      const pulled = await downloadExample(source, manifest, downloadPath, { ...request, platform });
      const { out, ...download } = pulled;
      return {
        operation: "download",
        revision: manifest.revision,
        id: manifest.id,
        destination: await realpath(out),
        ...download,
        aggregateSha256: manifest.aggregateSha256,
        ...offlineMetadata,
      };
    },
  };
}

function downloadDestination(root, destination) {
  if (typeof destination === "string" && (destination === ".." || destination.startsWith("../"))) {
    throw usage("Download destination must stay inside the configured output directory");
  }
  if (typeof destination !== "string" || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(destination)) {
    throw usage("Download destination must be a safe relative path");
  }
  try {
    assertSafeRelativePath(destination);
  } catch {
    throw usage("Download destination must be a safe relative path");
  }
  const resolvedRoot = resolve(root);
  const resolvedDestination = resolve(resolvedRoot, destination);
  const fromRoot = relative(resolvedRoot, resolvedDestination);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw usage("Download destination must stay inside the configured output directory");
  }
  return resolvedDestination;
}

async function assertNewDownloadDestination(root, relativeDestination, destination) {
  let candidate = resolve(root);
  for (const part of relativeDestination.split("/")) {
    candidate = resolve(candidate, part);
    let status;
    try {
      status = await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw filesystem(`Cannot inspect download destination: ${error.message}`);
    }
    if (status.isSymbolicLink()) throw filesystem("Download destination must not traverse a symbolic link");
  }
  throw destinationExists(`Destination already exists: ${destination}`);
}
