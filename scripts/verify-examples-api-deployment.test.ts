/**
 * TGEIST-13 — tests for the G4 deployment parity verifier.
 *
 * The interesting half is not the pure helpers: it is that the crawler actually catches a
 * deployment that serves ALMOST the right tree. So most of these tests boot a real HTTP server on
 * 127.0.0.1 that replays the committed artifact tree with the same headers the Next route handlers
 * produce, and then break exactly one thing at a time (one flipped byte, one wrong content-type, a
 * missing object, a stale index) and assert the verdict turns red for the right reason.
 *
 * No network egress: every request goes to the loopback server, and the A/B mode is exercised by
 * running two of them.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error -- dependency-free .mjs script, intentionally untyped (see the file header).
import * as verifier from "./verify-examples-api-deployment.mjs";

const {
  DISCOVERY_ARTIFACT_KEY,
  LATEST_ARTIFACT_KEY,
  IMMUTABLE_CACHE_CONTROL,
  MUTABLE_CACHE_CONTROL,
  artifactKind,
  artifactPathForKey,
  backoffDelayMs,
  compareReports,
  detectBlock,
  expectedCacheControl,
  expectedContentType,
  formatReport,
  isRetriableStatus,
  keyForArtifactPath,
  normalizeBaseUrl,
  normalizeEtag,
  parseArguments,
  verifyDeployment,
} = verifier;

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const treeRoot = join(repoRoot, "apps/docs/generated/examples-api");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("artifact keys map to the paths the two route groups actually serve", () => {
  expect(artifactPathForKey(DISCOVERY_ARTIFACT_KEY)).toBe("/.well-known/vgpu-examples.json");
  expect(artifactPathForKey(LATEST_ARTIFACT_KEY)).toBe("/api/examples/v1/latest.json");
  expect(artifactPathForKey("examples/v1/revisions/abc/index.json")).toBe("/api/examples/v1/revisions/abc/index.json");
  expect(keyForArtifactPath("/.well-known/vgpu-examples.json")).toBe(DISCOVERY_ARTIFACT_KEY);
  expect(keyForArtifactPath("/api/examples/v1/latest.json")).toBe(LATEST_ARTIFACT_KEY);
  expect(keyForArtifactPath("/docs/examples")).toBeUndefined();
});

test("content-type expectation mirrors withCharset in artifact-store.ts", () => {
  expect(expectedContentType("text/wgsl")).toBe("text/wgsl; charset=utf-8");
  expect(expectedContentType("text/typescript")).toBe("text/typescript; charset=utf-8");
  expect(expectedContentType("application/json; charset=utf-8")).toBe("application/json; charset=utf-8");
  expect(expectedContentType("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
});

test("only the two mutable artifacts get the revalidating cache-control", () => {
  expect(expectedCacheControl(DISCOVERY_ARTIFACT_KEY)).toBe(MUTABLE_CACHE_CONTROL);
  expect(expectedCacheControl(LATEST_ARTIFACT_KEY)).toBe(MUTABLE_CACHE_CONTROL);
  expect(expectedCacheControl("examples/v1/revisions/abc/index.json")).toBe(IMMUTABLE_CACHE_CONTROL);
});

test("artifact kinds classify the whole tree", () => {
  expect(artifactKind(DISCOVERY_ARTIFACT_KEY)).toBe("discovery");
  expect(artifactKind(LATEST_ARTIFACT_KEY)).toBe("latest");
  expect(artifactKind("examples/v1/revisions/a/revision.json")).toBe("revision");
  expect(artifactKind("examples/v1/revisions/a/index.json")).toBe("index");
  expect(artifactKind("examples/v1/revisions/a/examples/gradient/manifest.json")).toBe("manifest");
  expect(artifactKind("examples/v1/revisions/a/examples/gradient/files/shader.wgsl.raw")).toBe("file");
});

test("a weak ETag is not a parity difference", () => {
  expect(normalizeEtag('"abc"')).toBe("abc");
  expect(normalizeEtag('W/"abc"')).toBe("abc");
  expect(normalizeEtag(undefined)).toBeUndefined();
});

test("base URLs are normalised, and nonsense is rejected", () => {
  expect(normalizeBaseUrl("vgpu.sh")).toBe("https://vgpu.sh");
  expect(normalizeBaseUrl("https://vgpu.sh/")).toBe("https://vgpu.sh");
  expect(normalizeBaseUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
  expect(() => normalizeBaseUrl("https://vgpu.sh/?x=1")).toThrow(/query or hash/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/Invalid deployment URL/);
});

test("Vercel bot mitigation and deployment protection are blocks, not parity failures", () => {
  expect(detectBlock(403, new Headers({ "x-vercel-mitigated": "challenge" }))).toMatchObject({
    blocked: true,
    reason: "bot-mitigation",
  });
  expect(detectBlock(401, new Headers({ "content-type": "text/html" }))).toMatchObject({
    blocked: true,
    reason: "deployment-protection",
  });
  expect(detectBlock(403, new Headers({ "content-type": "text/html; charset=utf-8" }))).toMatchObject({ blocked: true });
  // A 404 or a 500 from the route itself IS a real failure and must stay one.
  expect(detectBlock(404, new Headers({ "content-type": "application/json" })).blocked).toBe(false);
  expect(detectBlock(500, new Headers()).blocked).toBe(false);
});

test("transient statuses are retried, permanent ones are not", () => {
  expect([408, 429, 500, 502, 503].every(isRetriableStatus)).toBe(true);
  expect([200, 304, 400, 404].some(isRetriableStatus)).toBe(false);
  expect(backoffDelayMs(0)).toBe(500);
  expect(backoffDelayMs(3)).toBe(4000);
  expect(backoffDelayMs(10)).toBe(8000);
});

test("argument parsing covers the single, A/B and local-cross-check shapes", () => {
  expect(parseArguments(["https://vgpu.sh"]).urls).toEqual(["https://vgpu.sh"]);
  expect(parseArguments(["vgpu.sh", "docs-next.vercel.app"]).urls).toEqual([
    "https://vgpu.sh",
    "https://docs-next.vercel.app",
  ]);
  expect(parseArguments(["vgpu.sh", "--compare", "docs-next.vercel.app"]).urls).toHaveLength(2);
  expect(parseArguments(["vgpu.sh", "--local"]).localTree).toBe("apps/docs/generated/examples-api");
  expect(parseArguments(["vgpu.sh", "--local=apps/docs-next/generated/examples-api"]).localTree).toBe(
    "apps/docs-next/generated/examples-api",
  );
  expect(parseArguments(["vgpu.sh", "--require-local"]).requireLocal).toBe(true);
  expect(parseArguments(["vgpu.sh", "--concurrency", "3", "--timeout", "1000", "--retries", "0"])).toMatchObject({
    concurrency: 3,
    timeoutMs: 1000,
    retries: 0,
  });
  expect(() => parseArguments([])).toThrow(/Missing <baseUrl>/);
  expect(() => parseArguments(["a", "b", "c"])).toThrow(/At most two/);
  expect(() => parseArguments(["vgpu.sh", "vgpu.sh"])).toThrow(/two different/);
  expect(() => parseArguments(["--nope"])).toThrow(/Unknown option/);
});

test("compareReports ignores baseUrl and timings but not bytes", () => {
  const artifact = {
    key: "examples/v1/latest.json",
    kind: "latest",
    status: 200,
    contentType: "application/json; charset=utf-8",
    contentLength: 10,
    bytes: 10,
    sha256: "a".repeat(64),
    etag: "a".repeat(64),
    cacheControl: MUTABLE_CACHE_CONTROL,
    ok: true,
  };
  const a = { baseUrl: "https://vgpu.sh", revision: "r", durationMs: 1, artifacts: [artifact] };
  const b = { baseUrl: "https://preview.vercel.app", revision: "r", durationMs: 999, artifacts: [{ ...artifact }] };
  expect(compareReports(a, b)).toEqual({ equal: true, differences: [] });

  const drifted = { ...b, artifacts: [{ ...artifact, sha256: "b".repeat(64) }] };
  expect(compareReports(a, drifted).equal).toBe(false);
  expect(compareReports(a, drifted).differences[0]).toMatchObject({ scope: "artifact", field: "sha256" });

  expect(compareReports(a, { ...b, revision: "other" }).differences[0]).toMatchObject({ scope: "revision" });
  expect(compareReports(a, { ...b, artifacts: [] }).differences[0]).toMatchObject({ scope: "missing-in-b" });
});

// ---------------------------------------------------------------------------
// Full-tree crawl against a replay of the committed artifact tree
// ---------------------------------------------------------------------------

/**
 * One-thing-at-a-time break. `headers` values overwrite the header the route would have sent;
 * `null` removes it. Header mutations are what keep the verifier honest in the OTHER direction:
 * they fail only while the corresponding assertion still exists in the script, so deleting an
 * assertion turns one of these tests red.
 */
type Mutation = (
  key: string,
  bytes: Buffer,
) => { bytes?: Buffer; status?: number; headers?: Record<string, string | null> } | undefined;

function loadTree(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const key = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(absolute).isDirectory()) walk(absolute, key);
      else files.set(key, readFileSync(absolute));
    }
  };
  walk(treeRoot, "");
  return files;
}

const tree = loadTree();

function contentTypeFor(key: string): string {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".wgsl.raw")) return "text/wgsl; charset=utf-8";
  return "text/typescript; charset=utf-8";
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Serves the committed tree exactly like the Next route handlers do (headers included). */
async function startReplayServer(mutate?: Mutation): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const key = keyForArtifactPath(path);
    const original = key ? tree.get(key) : undefined;
    if (!key || !original) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" }).end("{}");
      return;
    }
    const override = mutate?.(key, original) ?? {};
    const bytes = override.bytes ?? original;
    if (override.status && override.status !== 200) {
      response.writeHead(override.status, { "content-type": "application/json; charset=utf-8" }).end("{}");
      return;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const headers: Record<string, string> = {
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "cache-control": expectedCacheControl(key),
      "content-type": contentTypeFor(key),
      etag: `"${digest}"`,
    };
    for (const [name, value] of Object.entries(override.headers ?? {})) {
      if (value === null) delete headers[name];
      else headers[name] = value;
    }
    // The real route derives the ETag from the bytes, so conditional GET keeps working even when a
    // mutation lies about the ETag header.
    if (request.headers["if-none-match"] === `"${digest}"`) {
      response.writeHead(304, headers).end();
      return;
    }
    headers["content-length"] ??= String(bytes.byteLength);
    response.writeHead(200, headers).end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const runOptions = { concurrency: 16, retries: 0, timeoutMs: 10_000 };

test("a faithful deployment verifies green over the whole tree", async () => {
  const baseUrl = await startReplayServer();
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.problems).toEqual([]);
  expect(report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok)).toEqual([]);
  // The whole committed tree, not just the three artifacts the generator's own hook checks.
  expect(report.counts.total).toBe(tree.size);
  expect(report.counts.byKind).toMatchObject({ discovery: 1, latest: 1, revision: 1, index: 1 });
  expect(report.ok).toBe(true);
  expect(formatReport(report)).toContain("verdict    PASS");
}, 60_000);

test("one flipped byte in one source file turns the verdict red", async () => {
  const target = [...tree.keys()].find((key) => key.endsWith("shader.wgsl.raw"))!;
  const baseUrl = await startReplayServer((key, bytes) =>
    key === target ? { bytes: Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from("X")]) } : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed).toHaveLength(1);
  expect(failed[0].key).toBe(target);
  expect(failed[0].problems.join(" ")).toMatch(/sha256 .* != declared/);
}, 60_000);

test("a truncated file is reported as both a size and a hash mismatch", async () => {
  // Length and hash are separate declarations, so both assertions must exist: a mutant that dropped
  // the size check would otherwise hide behind sha256.
  const target = [...tree.keys()].find((key) => key.endsWith("renderer.ts.raw"))!;
  const baseUrl = await startReplayServer((key, bytes) => (key === target ? { bytes: bytes.subarray(0, bytes.length - 3) } : undefined));
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed.map((artifact: { key: string }) => artifact.key)).toEqual([target]);
  expect(failed[0].problems.join(" ")).toMatch(/size \d+ != declared \d+/);
  expect(failed[0].problems.join(" ")).toMatch(/sha256 .* != declared/);
}, 60_000);

test("a wrong content-type on a source file is caught even when the bytes are right", async () => {
  const target = [...tree.keys()].find((key) => key.endsWith("shader.wgsl.raw"))!;
  const baseUrl = await startReplayServer((key) =>
    key === target ? { headers: { "content-type": "text/plain; charset=utf-8" } } : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  expect(report.artifacts.find((artifact: { key: string }) => artifact.key === target).problems.join(" ")).toMatch(
    /content-type .*text\/plain/,
  );
}, 60_000);

// The tests above break the SERVER; a verifier that dropped an assertion would still pass them
// as long as sha256 stayed. These break the server in ways only ONE assertion can see, so removing
// that assertion from the script turns exactly one of them red (mutation testing, per review).

test("an ETag that is not the sha256 of the body is caught, with the right bytes served", async () => {
  const target = [...tree.keys()].find((key) => key.endsWith("shader.wgsl.raw"))!;
  const baseUrl = await startReplayServer((key) => (key === target ? { headers: { etag: `"${"c".repeat(64)}"` } } : undefined));
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed).toHaveLength(1);
  expect(failed[0].key).toBe(target);
  expect(failed[0].problems.join(" ")).toMatch(/etag .* != sha256 of the body/);
}, 60_000);

test("an immutable revision object served with the mutable cache-control is caught", async () => {
  const target = [...tree.keys()].find((key) => key.endsWith("index.json"))!;
  const baseUrl = await startReplayServer((key) =>
    key === target ? { headers: { "cache-control": MUTABLE_CACHE_CONTROL } } : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed).toHaveLength(1);
  expect(failed[0].problems.join(" ")).toMatch(/cache-control .*max-age=60.* != .*immutable/);
}, 60_000);

test("a missing CORS allow-origin is caught — the CLI is a cross-origin client", async () => {
  const target = LATEST_ARTIFACT_KEY;
  const baseUrl = await startReplayServer((key) =>
    key === target ? { headers: { "access-control-allow-origin": null } } : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed).toHaveLength(1);
  expect(failed[0].key).toBe(target);
  expect(failed[0].problems).toContain("missing CORS allow-origin: *");
}, 60_000);

test("a missing x-content-type-options is caught", async () => {
  const target = DISCOVERY_ARTIFACT_KEY;
  const baseUrl = await startReplayServer((key) =>
    key === target ? { headers: { "x-content-type-options": null } } : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed).toHaveLength(1);
  expect(failed[0].key).toBe(target);
  expect(failed[0].problems).toContain("missing x-content-type-options: nosniff");
}, 60_000);

// --- graph closure, one branch per test ------------------------------------
// All three serve a tree where every object is individually perfect: only the relationship between
// the documents is wrong. Nothing but the closure checks can see them.

const revisionKey = [...tree.keys()].find((key) => key.endsWith("/revision.json"))!;

/** Rewrites revision.json's `objects` array; every other artifact stays byte-perfect. */
function withRevisionObjects(transform: (objects: { key: string }[]) => { key: string }[]): Mutation {
  return (key, bytes) => {
    if (key !== revisionKey) return undefined;
    const document = JSON.parse(bytes.toString("utf8"));
    return { bytes: Buffer.from(JSON.stringify({ ...document, objects: transform(document.objects) })) };
  };
}

test("a manifest the index references but revision.json does not declare is caught", async () => {
  const orphanedManifest = [...tree.keys()].find((key) => key.endsWith("/manifest.json"))!;
  const baseUrl = await startReplayServer(
    withRevisionObjects((objects) => objects.filter((object) => object.key !== orphanedManifest)),
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  expect(report.problems).toContain(`index references an undeclared manifest: ${orphanedManifest}`);
  // Every object still serves perfect bytes: only the relationship is broken.
  expect(report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok)).toEqual([]);
}, 60_000);

test("a source file a manifest references but revision.json does not declare is caught", async () => {
  const orphanedFile = [...tree.keys()].find((key) => key.endsWith(".raw"))!;
  const baseUrl = await startReplayServer(
    withRevisionObjects((objects) => objects.filter((object) => object.key !== orphanedFile)),
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  expect(
    report.problems.some(
      (problem: string) => problem.includes("manifest.json references an undeclared file:") && problem.endsWith(orphanedFile),
    ),
  ).toBe(true);
  // The file itself still serves perfect bytes, but with nothing declaring it there is no
  // content-type to grade it against, so it also falls back to the entry-document invariant and
  // fails there. Both signals point at the same undeclared object, and at no other one.
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed.map((artifact: { key: string }) => artifact.key)).toEqual([orphanedFile]);
  expect(failed[0].declared).toBeNull();
}, 60_000);

test("an object revision.json declares that no document references is caught", async () => {
  const ghost = `${revisionKey.replace(/revision\.json$/, "")}examples/ghost/files/ghost.ts.raw`;
  const baseUrl = await startReplayServer(
    withRevisionObjects((objects) => [
      ...objects,
      { key: ghost, size: 1, sha256: "d".repeat(64), contentType: "text/typescript" } as never,
    ]),
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  expect(report.problems).toContain(`revision.json declares an object no document references: ${ghost}`);
  // A declared-but-unreachable object must not be silently skipped: the tree is still 248 fetches,
  // and the failure comes from the closure check, not from a 404.
  expect(report.counts.total).toBe(tree.size);
  expect(report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok)).toEqual([]);
}, 60_000);

// --- the three independent declarations of the same bytes ------------------
// revision.json, the index and each manifest all declare hashes. Each pair must be checked, or a
// deployment that serves a self-consistent-but-wrong tree passes.

test("a content-length that disagrees with the body is caught (a compressed response)", async () => {
  // The realistic shape of this failure: an edge that gzips despite `accept-encoding: identity`, so
  // content-length is the compressed size while the decoded body — and its sha256 — are correct.
  const target = [...tree.keys()].find((key) => key.endsWith("index.json"))!;
  const baseUrl = await startReplayServer((key, bytes) =>
    key === target
      ? {
          bytes: gzipSync(bytes),
          headers: { "content-encoding": "gzip", "content-length": String(gzipSync(bytes).byteLength) },
        }
      : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed.map((artifact: { key: string }) => artifact.key)).toEqual([target]);
  expect(failed[0].problems.join(" ")).toMatch(/content-length \d+ != received \d+ bytes/);
}, 60_000);

test("an index whose hash disagrees with latest.indexSha256 is caught", async () => {
  const indexKey = [...tree.keys()].find((key) => key.endsWith("index.json"))!;
  const baseUrl = await startReplayServer((key, bytes) =>
    key === LATEST_ARTIFACT_KEY
      ? { bytes: Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString("utf8")), indexSha256: "b".repeat(64) })) }
      : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed.map((artifact: { key: string }) => artifact.key)).toEqual([indexKey]);
  expect(failed[0].problems.join(" ")).toMatch(/!= latest\.indexSha256 b{64}/);
}, 60_000);

test("a manifest whose file declaration disagrees with revision.json is caught", async () => {
  // Both documents stay internally consistent (the manifest's own hash in revision.json and in the
  // index is updated to match its new bytes), so ONLY the manifest-vs-revision.json cross-check can
  // see it: exactly the mutant that survived before.
  const manifestKey = [...tree.keys()].find((key) => key.endsWith("/manifest.json"))!;
  const manifestDocument = JSON.parse(tree.get(manifestKey)!.toString("utf8"));
  const [victim, ...rest] = manifestDocument.files;
  const mutatedManifest = Buffer.from(
    JSON.stringify({ ...manifestDocument, files: [{ ...victim, sha256: "e".repeat(64), size: victim.size + 1 }, ...rest] }),
  );
  const mutatedDigest = createHash("sha256").update(mutatedManifest).digest("hex");
  const baseUrl = await startReplayServer((key, bytes) => {
    if (key === manifestKey) return { bytes: mutatedManifest };
    if (key === revisionKey) {
      const document = JSON.parse(bytes.toString("utf8"));
      return {
        bytes: Buffer.from(
          JSON.stringify({
            ...document,
            objects: document.objects.map((object: { key: string }) =>
              object.key === manifestKey ? { ...object, size: mutatedManifest.byteLength, sha256: mutatedDigest } : object,
            ),
          }),
        ),
      };
    }
    if (key.endsWith("index.json")) {
      const document = JSON.parse(bytes.toString("utf8"));
      return {
        bytes: Buffer.from(
          JSON.stringify({
            ...document,
            examples: document.examples.map((entry: { manifestUrl: string; manifestSha256: string }) =>
              manifestKey.endsWith(new URL(entry.manifestUrl).pathname.split("/revisions/")[1])
                ? { ...entry, manifestSha256: mutatedDigest }
                : entry,
            ),
          }),
        ),
      };
    }
    return undefined;
  });
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const messages = report.problems.join(" ");
  expect(messages).toMatch(/manifest sha256 != revision\.json sha256/);
  expect(messages).toMatch(/manifest size != revision\.json size/);
}, 60_000);

test("a manifest whose bytes disagree with the index's manifestSha256 is caught", async () => {
  // revision.json is updated to match the new manifest bytes, so the index anchor is the only
  // remaining witness.
  const manifestKey = [...tree.keys()].find((key) => key.endsWith("/manifest.json"))!;
  const mutatedManifest = Buffer.concat([tree.get(manifestKey)!, Buffer.from(" ")]);
  const mutatedDigest = createHash("sha256").update(mutatedManifest).digest("hex");
  const baseUrl = await startReplayServer((key, bytes) => {
    if (key === manifestKey) return { bytes: mutatedManifest };
    if (key === revisionKey) {
      const document = JSON.parse(bytes.toString("utf8"));
      return {
        bytes: Buffer.from(
          JSON.stringify({
            ...document,
            objects: document.objects.map((object: { key: string }) =>
              object.key === manifestKey ? { ...object, size: mutatedManifest.byteLength, sha256: mutatedDigest } : object,
            ),
          }),
        ),
      };
    }
    return undefined;
  });
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  const failed = report.artifacts.filter((artifact: { ok: boolean }) => !artifact.ok);
  expect(failed.map((artifact: { key: string }) => artifact.key)).toEqual([manifestKey]);
  expect(failed[0].problems.join(" ")).toMatch(/!= index\.manifestSha256/);
}, 60_000);

test("a redirect is a parity failure, not an inconclusive BLOCKED", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(308, { location: "https://www.vgpu.sh/.well-known/vgpu-examples.json" }).end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  servers.push(server);
  const report = await verifyDeployment(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, runOptions);
  expect(report.ok).toBe(false);
  expect(report.artifacts[0].status).toBe(308);
  expect(report.artifacts[0].problems.join(" ")).toMatch(/unexpected redirect to https:\/\/www\.vgpu\.sh/);
}, 30_000);

test("an artifact missing from the deployment is a failure, not a silently shorter tree", async () => {
  const target = [...tree.keys()].find((key) => key.endsWith("manifest.json"))!;
  const baseUrl = await startReplayServer((key) => (key === target ? { status: 404 } : undefined));
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  expect(report.artifacts.find((artifact: { key: string }) => artifact.key === target).problems.join(" ")).toMatch(
    /expected HTTP 200, got 404/,
  );
}, 60_000);

test("a latest pointer aimed at a revision the deployment does not carry is caught", async () => {
  const stale = "0".repeat(64);
  const baseUrl = await startReplayServer((key, bytes) =>
    key === LATEST_ARTIFACT_KEY
      ? {
          bytes: Buffer.from(
            JSON.stringify({
              ...JSON.parse(bytes.toString("utf8")),
              revision: stale,
              indexUrl: `https://vgpu.sh/api/examples/v1/revisions/${stale}/index.json`,
            }),
          ),
        }
      : undefined,
  );
  const report = await verifyDeployment(baseUrl, runOptions);
  expect(report.ok).toBe(false);
  expect(report.revision).toBe(stale);
  expect(JSON.stringify(report)).toMatch(/expected HTTP 200, got 404/);
}, 60_000);

test("A/B parity is green between two identical deployments and red when one drifts", async () => {
  const [a, b] = await Promise.all([startReplayServer(), startReplayServer()]);
  const [reportA, reportB] = [await verifyDeployment(a, runOptions), await verifyDeployment(b, runOptions)];
  expect(compareReports(reportA, reportB)).toEqual({ equal: true, differences: [] });

  const target = [...tree.keys()].find((key) => key.endsWith("shader.wgsl.raw"))!;
  const drifted = await startReplayServer((key, bytes) =>
    key === target ? { bytes: Buffer.concat([bytes, Buffer.from("\n")]) } : undefined,
  );
  const comparison = compareReports(reportA, await verifyDeployment(drifted, runOptions));
  expect(comparison.equal).toBe(false);
  expect(comparison.differences.map((difference: { field?: string }) => difference.field)).toContain("sha256");
}, 120_000);

test("bot mitigation aborts the run as BLOCKED instead of reporting a parity failure", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "x-vercel-mitigated": "challenge", "content-type": "text/html" }).end("<html>");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await expect(verifyDeployment(baseUrl, runOptions)).rejects.toMatchObject({
    name: "BlockedError",
    detail: { reason: "bot-mitigation" },
  });
}, 30_000);
