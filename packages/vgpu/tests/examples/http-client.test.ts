import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runExamples } from "../../lib/examples/run.js";
import { ExamplesClient } from "../../lib/examples/client.js";
import { ExamplesCache } from "../../lib/examples/cache.js";
import { aggregateSha256, sha256 } from "../../lib/examples/hashing.js";
import { requestBytes } from "../../lib/examples/http.js";
import { EXAMPLES_SCHEMA_SHA256 } from "../../lib/examples/contracts.js";

const revision = "1".repeat(64);
const source = Buffer.from("export const answer = 42;\n");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture(change: Record<string, unknown> = {}) {
  const requests: string[] = [];
  let origin = "", discovery: Buffer, pointer: Buffer, indexBytes: Buffer, manifestBytes: Buffer;
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const send = (body: Buffer, type = "application/json; charset=utf-8", etag?: string) => { res.setHeader("content-type", change.wrongType ? "text/html" : type); if(etag)res.setHeader("etag",etag); res.end(body); };
    if (req.url === "/.well-known/vgpu-examples.json") { if(change.etag&&req.headers["if-none-match"]==='"discovery"'){res.statusCode=304;res.setHeader("etag",'"discovery"');return res.end()} return send(change.oversize ? Buffer.alloc(32769) : discovery,undefined,change.etag?'"discovery"':undefined); }
    if (req.url === "/api/examples/v1/latest.json") return send(pointer);
    if (req.url === `/examples/v1/revisions/${revision}/index.json`) { const tag=`"${sha256(indexBytes)}"`;if(change.etag&&req.headers["if-none-match"]===tag){res.statusCode=304;res.setHeader("etag",tag);return res.end()}return send(indexBytes,undefined,change.etag?tag:undefined); }
    if (req.url?.endsWith("/manifest.json")) return send(manifestBytes);
    if (req.url?.endsWith("/example.ts.raw")) { if(change.truncateFile){res.setHeader("content-type","text/typescript");res.setHeader("content-length",source.length+10);res.write(source.subarray(0,4));return setImmediate(()=>res.destroy());} return send(change.badFile ? Buffer.concat([source, Buffer.from("x")]) : source, "text/typescript"); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const file = { path: "example.ts", contentType: "text/typescript", size: source.length, sha256: sha256(source), url: `${origin}/examples/v1/revisions/${revision}/examples/raymarched-fractal/files/example.ts.raw` };
  const manifest: any = { schemaVersion: 1, contractId: "vgpu-examples/v1", revision, id: "raymarched-fractal", title: "Raymarched fractal", description: "Sierpinski raymarch", tags: ["raymarching"], capabilities: ["hdr"], aggregateSha256: "", files: [file] };
  manifest.aggregateSha256 = aggregateSha256(manifest);
  manifestBytes = Buffer.from(JSON.stringify(manifest));
  const entry = { id: manifest.id, title: manifest.title, description: manifest.description, tags: manifest.tags, capabilities: manifest.capabilities, fileCount: 1, aggregateSha256: manifest.aggregateSha256, manifestUrl: `${origin}/examples/v1/revisions/${revision}/examples/${manifest.id}/manifest.json`, manifestSha256: sha256(manifestBytes) };
  indexBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, contractId: "vgpu-examples/v1", revision, source: { repository: "repo", gitCommit: "commit" }, examples: [entry] }));
  pointer = Buffer.from(JSON.stringify({ schemaVersion: 1, contractId: "vgpu-examples/v1", revision, indexUrl: `${origin}/examples/v1/revisions/${revision}/index.json`, indexSha256: sha256(indexBytes) }));
  const contracts:any[]=[
    { id: "vgpu-examples/v2", schemaSha256: "2".repeat(64), status: "active", minimumCliVersion: "0.1.0", indexUrl: `${origin}/api/examples/v2/latest.json` },
    { id: "vgpu-examples/v1", schemaSha256: change.schema ?? EXAMPLES_SCHEMA_SHA256, status: change.status ?? "active", minimumCliVersion: change.minimum ?? "0.1.0", indexUrl: change.foreignIndexUrl ? "https://vgpu.sh/api/examples/v1/latest.json" : `${origin}/api/examples/v1/latest.json` },
  ];if(change.duplicate)contracts.push({...contracts[1],status:"revoked"});discovery = Buffer.from(JSON.stringify({ protocol: "vgpu-examples", discoveryVersion: 1, contracts }));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  return { origin, requests, poisonPointer(){ pointer=Buffer.from(JSON.stringify({schemaVersion:1,contractId:"vgpu-examples/v1",revision,indexUrl:`${origin}/examples/v1/revisions/${revision}/index.json`,indexSha256:"f".repeat(64)})); } };
}
async function testEnv() { const root = await mkdtemp(join(tmpdir(), "examples-cache-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return { VGPU_CACHE_DIR: root } as any; }

test("ExamplesClient propagates external cancellation through discovery without rewriting the AbortError", async () => {
  const root = await mkdtemp(join(tmpdir(), "examples-cancel-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const hangingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const client = new ExamplesClient({
    baseUrl: "http://127.0.0.1:1",
    fetchImpl: hangingFetch,
    cache: new ExamplesCache(root, { persistent: false }),
    timeoutMs: 100,
  });

  const request = client.getIndex({ signal: controller.signal });
  controller.abort();

  await expect(request).rejects.toBe(controller.signal.reason);
});

test("requestBytes rejects cancellation that races with a valid 304 response", async () => {
  const controller = new AbortController();
  const cancellation = new DOMException("cancelled after response", "AbortError");
  const etag = '"cached"';
  const fetchImpl: typeof fetch = async () => {
    controller.abort(cancellation);
    return new Response(null, { status: 304, headers: { etag } });
  };

  const request = requestBytes("https://vgpu.sh/cached.json", {
    fetchImpl,
    limit: 1024,
    contentTypes: ["application/json"],
    etag,
    signal: controller.signal,
  });

  await expect(request).rejects.toBe(cancellation);
});

test("requestBytes rejects a timeout that races with a valid 304 response", async () => {
  const etag = '"cached"';
  const fetchImpl: typeof fetch = async (_input, init) => {
    await new Promise<void>((resolve) => {
      init?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return new Response(null, { status: 304, headers: { etag } });
  };

  const request = requestBytes("https://vgpu.sh/slow-cached.json", {
    fetchImpl,
    limit: 1024,
    contentTypes: ["application/json"],
    etag,
    timeoutMs: 1,
  });

  await expect(request).rejects.toMatchObject({
    code: "VGPU-EXAMPLES-NETWORK",
    message: "Request timed out: https://vgpu.sh/slow-cached.json",
  });
});

test("requestBytes rejects when a timed-out body closes without surfacing an AbortError", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    },
  }), { headers: { "content-type": "application/json" } });

  const request = requestBytes("https://vgpu.sh/slow-body.json", {
    fetchImpl,
    limit: 1024,
    contentTypes: ["application/json"],
    timeoutMs: 1,
  });

  await expect(request).rejects.toMatchObject({
    code: "VGPU-EXAMPLES-NETWORK",
    message: "Truncated or timed out response: https://vgpu.sh/slow-body.json",
  });
});

test("selects v1 beside v2, searches without source fetch, cats verified bytes, then works offline", async () => {
  const f = await fixture(), env = await testEnv();
  const search = await runExamples(["search", "raymarching", "--base-url", f.origin], { version: "0.1.6", env });
  expect(search.code).toBe(0); expect(JSON.parse(search.stdout as string).results[0].id).toBe("raymarched-fractal");
  expect(f.requests.some((x) => x.endsWith(".raw"))).toBe(false);
  const cat = await runExamples(["cat", "raymarched-fractal", "example.ts", "--base-url", f.origin], { version: "0.1.6", env });
  expect(cat).toMatchObject({ code: 0, stdout: source });
  const offline = await runExamples(["show", "raymarched-fractal", "--offline"], { version: "0.1.6", env, fetchImpl: () => { throw new Error("socket opened"); } });
  if(process.platform==='linux'){expect(offline.code).toBe(0);expect(JSON.parse(offline.stdout as string).lastVerifiedAt).toBeTruthy()}
  else{expect(offline.code).toBe(4);expect(JSON.parse(offline.stderr!).error.code).toBe("VGPU-EXAMPLES-NETWORK")}
});

test.each(['darwin','win32'])("runs online commands with a per-invocation cache on %s",async platform=>{
  const f=await fixture(),env=await testEnv();
  const cat=await runExamples(["cat","raymarched-fractal","example.ts","--base-url",f.origin],{version:"0.1.6",env,platform});
  expect(cat).toMatchObject({code:0,stdout:source});
  expect(await runExamples(["cache","path"],{env,platform})).toEqual({code:0,stdout:"memory\n"});
  expect(await runExamples(["cache","clear"],{env,platform})).toEqual({code:0,stdout:'{"cleared":true,"path":"memory"}\n'});
  const offline=await runExamples(["show","raymarched-fractal","--offline"],{version:"0.1.6",env,platform,fetchImpl:()=>{throw new Error("socket opened")}});
  expect(offline.code).toBe(4);expect(JSON.parse(offline.stderr!).error.message).toContain(platform==='win32'?'Windows':'macOS');
});

test("conditionally revalidates with 304 and rejects a 304 when the pointer hash changes", async()=>{
  const f=await fixture({etag:true}),env=await testEnv();
  expect((await runExamples(["search","raymarching","--base-url",f.origin],{version:"0.1.6",env})).code).toBe(0);
  expect((await runExamples(["search","raymarching","--base-url",f.origin],{version:"0.1.6",env})).code).toBe(0);
  f.poisonPointer();
  const hostile=await runExamples(["search","raymarching","--base-url",f.origin],{version:"0.1.6",env});
  expect(hostile.code).toBe(5);expect(JSON.parse(hostile.stderr!).error.code).toBe("VGPU-EXAMPLES-INTEGRITY");
});

test.each([
  [{ status: "revoked" }, "VGPU-EXAMPLES-INCOMPATIBLE-API"],
  [{ schema: "0".repeat(64) }, "VGPU-EXAMPLES-INCOMPATIBLE-API"],
  [{ minimum: "99.0.0" }, "VGPU-EXAMPLES-CLI-TOO-OLD"],
  [{ duplicate: true }, "VGPU-EXAMPLES-INTEGRITY"],
])("fails discovery before fetching index", async (change, code) => {
  const f = await fixture(change), result = await runExamples(["search", "x", "--base-url", f.origin], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5); expect(JSON.parse(result.stderr!).error.code).toBe(code); expect(f.requests).toEqual(["/.well-known/vgpu-examples.json"]);
});

// #255: handshake() now evaluates schemaSha256 -> status -> minimumCliVersion -> assertTrustedUrl.
// These tests pin that NEW order. They intentionally change what used to be true: an old CLI talking
// to a migrated (off-origin) contract now sees VGPU-EXAMPLES-CLI-TOO-OLD instead of
// VGPU-EXAMPLES-INTEGRITY (see apps/docs/examples-api.md, "Client compatibility and the version gate").
// Revocation and deprecation still take precedence over the version gate — see the two tests below
// that pin that (a′ vs. the issue's literal proposal).

test("#255: old CLI against a migrated (off-origin) contract gets CLI-TOO-OLD, not INTEGRITY", async () => {
  const f = await fixture({ foreignIndexUrl: true, minimum: "99.0.0" });
  const result = await runExamples(["search", "x", "--base-url", f.origin], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5);
  expect(JSON.parse(result.stderr!).error.code).toBe("VGPU-EXAMPLES-CLI-TOO-OLD");
  expect(f.requests).toEqual(["/.well-known/vgpu-examples.json"]);
});

test("#255: current CLI against an off-origin contract still gets INTEGRITY (trust check survives the reorder)", async () => {
  const f = await fixture({ foreignIndexUrl: true });
  const result = await runExamples(["search", "x", "--base-url", f.origin], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5);
  expect(JSON.parse(result.stderr!).error.code).toBe("VGPU-EXAMPLES-INTEGRITY");
});

test("#255: revocation still wins over an advisory version gate for an old CLI (a\u2032, not the issue's literal order)", async () => {
  const f = await fixture({ status: "revoked", minimum: "99.0.0" });
  const result = await runExamples(["search", "x", "--base-url", f.origin], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5);
  expect(JSON.parse(result.stderr!).error.code).toBe("VGPU-EXAMPLES-INCOMPATIBLE-API");
});

// #255: triple conflict (revoked + too-old CLI + off-origin indexUrl). This is the one extra
// observable delta of the reorder besides CLI-TOO-OLD: the old order hit assertTrustedUrl second and
// reported INTEGRITY, hiding the kill switch behind an origin complaint. The kill switch now wins.
test("#255: revoked wins over both the version gate and the trust check for an off-origin contract", async () => {
  const f = await fixture({ status: "revoked", minimum: "99.0.0", foreignIndexUrl: true });
  const result = await runExamples(["search", "x", "--base-url", f.origin], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5);
  expect(JSON.parse(result.stderr!).error.code).toBe("VGPU-EXAMPLES-INCOMPATIBLE-API");
  expect(f.requests).toEqual(["/.well-known/vgpu-examples.json"]);
});

test("#255: deprecated warning still precedes CLI-TOO-OLD, not masked by the reorder", async () => {
  const f = await fixture({ status: "deprecated", minimum: "99.0.0" });
  const warnings: string[] = [];
  const client = new ExamplesClient({ baseUrl: f.origin, cliVersion: "0.1.6", warn: (msg: string) => warnings.push(msg) });
  await expect(client.handshake()).rejects.toMatchObject({ code: "VGPU-EXAMPLES-CLI-TOO-OLD" });
  expect(warnings).toEqual(["Warning: vgpu-examples/v1 is deprecated.\n"]);
});

test("#255: --revision does not bypass the trust check in handshake()", async () => {
  const f = await fixture({ foreignIndexUrl: true });
  const result = await runExamples(["search", "x", "--base-url", f.origin, "--revision", revision], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5);
  expect(JSON.parse(result.stderr!).error.code).toBe("VGPU-EXAMPLES-INTEGRITY");
});

test("keeps cat stdout empty when the source body breaks after headers",async()=>{const f=await fixture({truncateFile:true}),result=await runExamples(["cat","raymarched-fractal","example.ts","--base-url",f.origin],{version:"0.1.6",env:await testEnv()});expect(result.code).toBe(4);expect(result.stdout).toBeUndefined()});

test("uses SemVer prerelease precedence for the minimum CLI kill switch",async()=>{const prerelease=await fixture({minimum:"0.1.6"}),old=await runExamples(["search","x","--base-url",prerelease.origin],{version:"0.1.6-beta.1",env:await testEnv()});expect(old.code).toBe(5);expect(JSON.parse(old.stderr!).error.code).toBe("VGPU-EXAMPLES-CLI-TOO-OLD");const release=await fixture({minimum:"0.1.6-beta.1"}),ok=await runExamples(["search","raymarching","--base-url",release.origin],{version:"0.1.6",env:await testEnv()});expect(ok.code).toBe(0)});

test.each([{ oversize: true }, { wrongType: true }, { badFile: true }])("keeps cat stdout empty on hostile transport", async (change) => {
  const f = await fixture(change), result = await runExamples(["cat", "raymarched-fractal", "example.ts", "--base-url", f.origin], { version: "0.1.6", env: await testEnv() });
  expect(result.code).toBe(5); expect(result.stdout).toBeUndefined();
});
