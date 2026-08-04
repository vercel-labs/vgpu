#!/usr/bin/env node
/**
 * TGEIST-13 — G4: byte-for-byte deployment parity for the examples API.
 *
 * WHAT THIS IS
 * ------------
 * `apps/docs/scripts/generate-examples-api.mjs:38-60` already embeds a deployment verifier
 * (`verifyDeployed`, the `beforeLatest` hook of `--publish`): it fetches THREE artifacts
 * (index + one manifest + one file, all for `raymarched-fractal`) from `VERCEL_DEPLOYMENT_URL`
 * and compares `content-type`, byte length and `sha256` before the latest pointer is advanced.
 * That is a pre-pointer smoke test of a publish transaction, not a parity gate, and it can only
 * ever run inside the generator.
 *
 * This script is that verifier extracted and generalised to the WHOLE artifact tree
 * (discovery + latest + revision manifest + index + every manifest + every source file — 248
 * objects today), runnable against any deployment URL, with a per-file report and an aggregate
 * verdict. It is gate G4 of Decision 1' of the geistdocs migration: run it against the OLD
 * production deployment and against the NEW `apps/docs-next` preview and require identical
 * results before the cutover (TGEIST-15), then again minutes after the cutover deploy (G5).
 *
 * The generator is deliberately NOT refactored to import this file: it stays byte-frozen for the
 * whole dual-run window (its copy under `apps/docs-next` is compared to it by G2,
 * `check-examples-api-transplant`). The duplication is 20 lines and is the cheap side of that
 * trade.
 *
 * WHAT IT CHECKS
 * --------------
 * It walks the deployment the way a real client does — discovery -> latest -> revision manifest
 * -> index -> per-example manifests -> source files — and for every object asserts:
 *   - HTTP 200 with no redirect (`redirect: 'error'`, `cache: 'no-store'`),
 *   - `content-type` exactly as declared by the revision manifest (`; charset=utf-8` appended to
 *     `text/*`, exactly as `artifact-store.ts#withCharset` does),
 *   - `content-length` header == received body length == declared `size`,
 *   - `sha256(body)` == declared `sha256`,
 *   - `etag` == `"<sha256>"` and `cache-control` == the value the route is supposed to set
 *     (immutable for revision objects, `max-age=60, must-revalidate` for the two mutable ones),
 *   - graph closure: every URL referenced by index/manifests exists in the revision manifest, and
 *     every object of the revision manifest is referenced (no orphans, nothing missing).
 * Plus HEAD + conditional-GET (`If-None-Match` -> 304) probes on the three entry artifacts, and an
 * optional cross-check against the generated tree committed in the checkout (`--local`).
 *
 * USAGE
 * -----
 *   node scripts/verify-examples-api-deployment.mjs <baseUrl>                  # one deployment
 *   node scripts/verify-examples-api-deployment.mjs <baseUrlA> <baseUrlB>      # A/B parity
 *   node scripts/verify-examples-api-deployment.mjs <baseUrl> --compare <baseUrlB>
 *
 * Options:
 *   --compare <url>     second deployment; equivalent to passing a second positional URL.
 *   --local[=<dir>]     also cross-check against a generated tree in this checkout
 *                       (default `apps/docs/generated/examples-api`). A revision mismatch is a
 *                       warning unless --require-local is given.
 *   --require-local     turn a local-tree revision mismatch / missing tree into a failure.
 *   --json <file>       write the machine-readable report (A/B writes `{a, b, comparison}`).
 *   --concurrency <n>   parallel requests per deployment (default 8).
 *   --timeout <ms>      per-request timeout (default 30000).
 *   --retries <n>       retries per request for transient failures (default 4).
 *   --head-all          send a HEAD for every artifact, not just the three entry ones.
 *   --verbose           print one line per artifact (default: failures + summary only).
 *   --help
 *
 * Environment:
 *   VERCEL_AUTOMATION_BYPASS_SECRET  sent as `x-vercel-protection-bypass` so the script can reach
 *                                    a preview deployment that has Vercel Deployment Protection
 *                                    enabled (the alternative — disabling protection — is worse).
 *
 * Exit codes: 0 pass · 1 parity/integrity failure · 2 usage error · 75 BLOCKED (inconclusive:
 * bot mitigation, deployment protection or the network — never reported as a parity failure).
 *
 * OPERATIONAL RULE (Risk #5 of the migration design): this script only READS a deployment over
 * HTTP. Verifying a preview must never be "simplified" by promoting it to the production domain;
 * the only path to the production domain is the cutover PR (F5/TGEIST-15).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// Mirrors apps/docs/lib/examples-api/route-config.ts. Duplicated on purpose: that module is
// TypeScript inside an app this ticket may not touch or import, and this script must stay
// dependency-free so it can run from a bare checkout (or from `npx`-style one-shot CI steps).
export const DISCOVERY_ARTIFACT_KEY = '.well-known/vgpu-examples.json';
export const LATEST_ARTIFACT_KEY = 'examples/v1/latest.json';
export const CONTRACT_ID = 'vgpu-examples/v1';
export const MUTABLE_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DEFAULT_LOCAL_TREE = 'apps/docs/generated/examples-api';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
/** EX_TEMPFAIL: the run is inconclusive, NOT a parity failure. */
export const EXIT_BLOCKED = 75;

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Raised when the deployment cannot be interrogated at all (bot mitigation, SSO, network). */
export class BlockedError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BlockedError';
    this.detail = detail ?? {};
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in verify-examples-api-deployment.test.ts)
// ---------------------------------------------------------------------------

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Artifact key -> request path. The discovery document is served from the site root
 * (`app/.well-known/vgpu-examples.json/route.ts`); everything else lives under `/api`
 * (`app/api/examples/v1/...`), which is exactly the `'/api/' + key` convention `verifyDeployed`
 * uses in the generator.
 */
export function artifactPathForKey(key) {
  return key === DISCOVERY_ARTIFACT_KEY ? `/${key}` : `/api/${key}`;
}

/** Inverse of artifactPathForKey; returns undefined for a path outside the artifact namespace. */
export function keyForArtifactPath(path) {
  if (path === `/${DISCOVERY_ARTIFACT_KEY}`) return DISCOVERY_ARTIFACT_KEY;
  if (path.startsWith('/api/')) return path.slice('/api/'.length);
  return undefined;
}

/** Mirrors `withCharset` in apps/docs/lib/examples-api/artifact-store.ts. */
export function expectedContentType(declared) {
  return declared.startsWith('text/') && !declared.includes(';') ? `${declared}; charset=utf-8` : declared;
}

/** Revision objects are immutable; discovery and the latest pointer are not. */
export function expectedCacheControl(key) {
  return key === DISCOVERY_ARTIFACT_KEY || key === LATEST_ARTIFACT_KEY
    ? MUTABLE_CACHE_CONTROL
    : IMMUTABLE_CACHE_CONTROL;
}

/** `W/"abc"` and `"abc"` both normalise to `abc`, so a CDN weakening the ETag is not a diff. */
export function normalizeEtag(value) {
  if (typeof value !== 'string') return undefined;
  return value.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1');
}

export function revisionArtifactKeyPrefix(revision) {
  return `examples/v1/revisions/${revision}`;
}

/** Classifies an artifact for the report, purely from its key. */
export function artifactKind(key) {
  if (key === DISCOVERY_ARTIFACT_KEY) return 'discovery';
  if (key === LATEST_ARTIFACT_KEY) return 'latest';
  if (key.endsWith('/revision.json')) return 'revision';
  if (key.endsWith('/index.json')) return 'index';
  if (key.endsWith('/manifest.json')) return 'manifest';
  return 'file';
}

/**
 * Vercel's transient anti-bot mitigation answers 403 with `x-vercel-mitigated: challenge`, and
 * Deployment Protection answers 401 with an SSO HTML page. Neither means "the bytes are wrong";
 * conflating them with a parity failure is how a green migration gets blocked by a red herring.
 */
export function detectBlock(status, headers) {
  const get = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? undefined;
  const mitigated = get('x-vercel-mitigated');
  if (mitigated) return { blocked: true, reason: 'bot-mitigation', detail: `x-vercel-mitigated: ${mitigated}` };
  if (status === 401 || status === 407) {
    return { blocked: true, reason: 'deployment-protection', detail: `HTTP ${status} (Vercel Deployment Protection / SSO)` };
  }
  if (status === 403 && /text\/html/i.test(get('content-type') ?? '')) {
    return { blocked: true, reason: 'bot-mitigation', detail: 'HTTP 403 with an HTML body (challenge page)' };
  }
  return { blocked: false };
}

export function isRetriableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function backoffDelayMs(attempt, base = 500, cap = 8000) {
  return Math.min(cap, base * 2 ** attempt);
}

export function parseArguments(argv) {
  const options = {
    urls: [],
    localTree: undefined,
    requireLocal: false,
    jsonPath: undefined,
    concurrency: 8,
    timeoutMs: 30_000,
    retries: 4,
    headAll: false,
    verbose: false,
    help: false,
  };
  const numeric = (raw, name) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid value for ${name}: ${raw}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      index += 1;
      return value;
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--compare') options.urls.push(next());
    else if (argument === '--local') options.localTree = DEFAULT_LOCAL_TREE;
    else if (argument.startsWith('--local=')) options.localTree = argument.slice('--local='.length);
    else if (argument === '--require-local') {
      options.requireLocal = true;
      options.localTree ??= DEFAULT_LOCAL_TREE;
    } else if (argument === '--json') options.jsonPath = next();
    else if (argument === '--concurrency') options.concurrency = numeric(next(), '--concurrency');
    else if (argument === '--timeout') options.timeoutMs = numeric(next(), '--timeout');
    else if (argument === '--retries') options.retries = numeric(next(), '--retries');
    else if (argument === '--head-all') options.headAll = true;
    else if (argument === '--verbose') options.verbose = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else options.urls.push(argument);
  }
  if (!options.help) {
    if (options.urls.length === 0) throw new Error('Missing <baseUrl>');
    if (options.urls.length > 2) throw new Error('At most two deployment URLs can be compared');
    options.urls = options.urls.map(normalizeBaseUrl);
    if (options.urls.length === 2 && options.urls[0] === options.urls[1]) {
      throw new Error('A/B mode needs two different deployment URLs');
    }
  }
  options.concurrency = Math.max(1, Math.trunc(options.concurrency));
  return options;
}

/** Accepts `vgpu.sh`, `https://vgpu.sh`, `https://vgpu.sh/` and normalises to an origin+path base. */
export function normalizeBaseUrl(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid deployment URL: ${value}`);
  }
  if (url.search || url.hash) throw new Error(`Deployment URL must not carry a query or hash: ${value}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The fields a deployment is allowed to be compared on — everything else is transport noise. */
export function comparableArtifact(artifact) {
  return {
    key: artifact.key,
    kind: artifact.kind,
    status: artifact.status,
    contentType: artifact.contentType,
    contentLength: artifact.contentLength,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    etag: artifact.etag,
    cacheControl: artifact.cacheControl,
    ok: artifact.ok,
  };
}

/**
 * A/B parity: two reports must describe the same tree, byte for byte. `baseUrl` and every
 * timing/telemetry field are excluded by construction (they are not part of `comparableArtifact`),
 * which is exactly the "diff of the two JSON reports is empty except for baseUrl" criterion.
 */
export function compareReports(a, b) {
  const differences = [];
  if (a.revision !== b.revision) {
    differences.push({ scope: 'revision', a: a.revision, b: b.revision });
  }
  const byKey = (report) => new Map(report.artifacts.map((artifact) => [artifact.key, artifact]));
  const artifactsA = byKey(a);
  const artifactsB = byKey(b);
  for (const key of artifactsA.keys()) {
    if (!artifactsB.has(key)) differences.push({ scope: 'missing-in-b', key });
  }
  for (const key of artifactsB.keys()) {
    if (!artifactsA.has(key)) differences.push({ scope: 'missing-in-a', key });
  }
  for (const [key, artifactA] of artifactsA) {
    const artifactB = artifactsB.get(key);
    if (!artifactB) continue;
    const left = comparableArtifact(artifactA);
    const right = comparableArtifact(artifactB);
    for (const field of Object.keys(left)) {
      if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) {
        differences.push({ scope: 'artifact', key, field, a: left[field], b: right[field] });
      }
    }
  }
  return { equal: differences.length === 0, differences };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function createFetcher(baseUrl, options) {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const baseHeaders = {
    // The API is a machine contract; asking for identity keeps `content-length` comparable with
    // the declared byte size instead of a compressed transfer size.
    'accept-encoding': 'identity',
    'user-agent': 'vgpu-verify-examples-api-deployment/1',
    ...(bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'false' } : {}),
  };

  return async function request(path, { method = 'GET', headers = {} } = {}) {
    const url = `${baseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: { ...baseHeaders, ...headers },
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        // `redirect: 'error'` rejects with a bare TypeError, indistinguishable from a DNS or TLS
        // failure — and the difference is the difference between the two verdicts this script is
        // careful to keep apart. A redirect is a real, deployment-side defect: the CLI fetches with
        // `redirect: 'error'` too, so an apex→www rewrite takes the API down for every client
        // (apps/docs/examples-api.md § Production setup). An unreachable host is inconclusive.
        // Re-probe once without following redirects to tell them apart.
        const redirected = await probeRedirect(url, method, { ...baseHeaders, ...headers }, options.timeoutMs);
        if (redirected) return redirected;
        continue;
      }
      const block = detectBlock(response.status, response.headers);
      if (block.blocked) {
        await response.arrayBuffer().catch(() => undefined);
        lastError = new BlockedError(`${block.reason}: ${block.detail}`, { ...block, url });
        // Mitigation/SSO clears on its own (or never); back off harder before giving up.
        if (attempt < options.retries) await sleep(backoffDelayMs(attempt, 2000, 15_000));
        continue;
      }
      if (isRetriableStatus(response.status) && attempt < options.retries) {
        await response.arrayBuffer().catch(() => undefined);
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const body = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
      return { url, status: response.status, headers: response.headers, body };
    }
    if (lastError instanceof BlockedError) throw lastError;
    throw new BlockedError(
      `Unreachable after ${options.retries + 1} attempts: ${url} (${lastError?.message ?? 'unknown error'})`,
      { reason: 'network', url },
    );
  };
}

/**
 * Second opinion after a rejected fetch: was it a redirect this script refused to follow? Returns a
 * synthetic response (so the artifact is graded, and fails, like any other wrong answer) or
 * `undefined` when the host is simply unreachable — in which case the caller keeps retrying and
 * ends at BLOCKED. A mitigation challenge that redirects stays BLOCKED too, on purpose.
 */
async function probeRedirect(url, method, headers, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { method, headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return undefined;
  }
  await response.arrayBuffer().catch(() => undefined);
  const isRedirect = response.status >= 300 && response.status < 400;
  if (!isRedirect || response.headers.get('x-vercel-mitigated')) return undefined;
  return {
    url,
    status: response.status,
    headers: response.headers,
    body: new Uint8Array(),
    redirectedTo: response.headers.get('location') ?? '(no Location header)',
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Artifact probing
// ---------------------------------------------------------------------------

/**
 * Fetches one artifact and grades it against `expected` (from the revision manifest) or, when the
 * artifact is one of the three self-describing entry documents, against the invariants the route
 * itself must satisfy.
 */
async function probeArtifact(request, key, expected) {
  const path = artifactPathForKey(key);
  const response = await request(path);
  const problems = [];
  const header = (name) => response.headers.get(name) ?? undefined;
  const contentType = header('content-type');
  const contentLengthHeader = header('content-length');
  const contentLength = contentLengthHeader === undefined ? undefined : Number(contentLengthHeader);
  const digest = sha256(response.body);

  if (response.status !== 200) problems.push(`expected HTTP 200, got ${response.status}`);
  if (response.redirectedTo !== undefined) {
    problems.push(
      `unexpected redirect to ${response.redirectedTo} — the CLI fetches with redirect: 'error', ` +
        'so any redirect on this host (an apex→www rewrite, a trailing-slash rule) fails every client',
    );
  }
  const wantedContentType = expected?.contentType ? expectedContentType(expected.contentType) : JSON_CONTENT_TYPE;
  if (contentType !== wantedContentType) {
    problems.push(`content-type ${JSON.stringify(contentType ?? null)} != ${JSON.stringify(wantedContentType)}`);
  }
  if (contentLength === undefined || Number.isNaN(contentLength)) {
    problems.push('missing content-length header');
  } else if (contentLength !== response.body.byteLength) {
    problems.push(`content-length ${contentLength} != received ${response.body.byteLength} bytes`);
  }
  if (expected?.size !== undefined && response.body.byteLength !== expected.size) {
    problems.push(`size ${response.body.byteLength} != declared ${expected.size}`);
  }
  if (expected?.sha256 !== undefined && digest !== expected.sha256) {
    problems.push(`sha256 ${digest} != declared ${expected.sha256}`);
  }
  const etag = normalizeEtag(header('etag'));
  if (etag !== digest) problems.push(`etag ${JSON.stringify(etag ?? null)} != sha256 of the body`);
  const cacheControl = header('cache-control');
  const wantedCacheControl = expectedCacheControl(key);
  if (cacheControl !== wantedCacheControl) {
    problems.push(`cache-control ${JSON.stringify(cacheControl ?? null)} != ${JSON.stringify(wantedCacheControl)}`);
  }
  if (header('access-control-allow-origin') !== '*') problems.push('missing CORS allow-origin: *');
  if (header('x-content-type-options') !== 'nosniff') problems.push('missing x-content-type-options: nosniff');

  return {
    key,
    path,
    kind: artifactKind(key),
    status: response.status,
    contentType: contentType ?? null,
    contentLength: contentLength ?? null,
    bytes: response.body.byteLength,
    sha256: digest,
    etag: etag ?? null,
    cacheControl: cacheControl ?? null,
    declared: expected ? { size: expected.size ?? null, sha256: expected.sha256 ?? null, contentType: expected.contentType ?? null } : null,
    anchoredBy: expected?.anchoredBy ?? 'self',
    ok: problems.length === 0,
    problems,
    body: response.body,
  };
}

function parseJsonBody(artifact) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.body));
  } catch (error) {
    artifact.ok = false;
    artifact.problems.push(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** URLs inside the documents carry the BAKED origin (https://vgpu.sh), so only the path travels. */
function keyFromReferencedUrl(value, problems, label) {
  if (typeof value !== 'string') {
    problems.push(`${label}: not a string`);
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    problems.push(`${label}: not an absolute URL (${value})`);
    return undefined;
  }
  const key = keyForArtifactPath(parsed.pathname);
  if (!key) problems.push(`${label}: path outside the artifact namespace (${parsed.pathname})`);
  return key;
}

// ---------------------------------------------------------------------------
// Local tree cross-check
// ---------------------------------------------------------------------------

async function loadLocalTree(directory) {
  const root = resolve(repoRoot, directory);
  const entries = new Map();
  const walk = async (current, prefix) => {
    let listing;
    try {
      listing = await readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read local tree ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of listing) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), key);
      else if (entry.isFile()) {
        const bytes = await readFile(join(current, entry.name));
        entries.set(key, { size: bytes.byteLength, sha256: sha256(bytes) });
      }
    }
  };
  await walk(root, '');
  return { root, entries };
}

function crossCheckLocalTree(tree, report, requireLocal) {
  const mismatches = [];
  const served = new Map(report.artifacts.map((artifact) => [artifact.key, artifact]));
  for (const [key, local] of tree.entries) {
    const artifact = served.get(key);
    if (!artifact) {
      mismatches.push({ key, problem: 'present in the checkout, not served by the deployment' });
      continue;
    }
    if (artifact.sha256 !== local.sha256) {
      mismatches.push({ key, problem: `sha256 differs (deployment ${artifact.sha256}, checkout ${local.sha256})` });
    } else if (artifact.bytes !== local.size) {
      mismatches.push({ key, problem: `size differs (deployment ${artifact.bytes}, checkout ${local.size})` });
    }
  }
  for (const key of served.keys()) {
    if (!tree.entries.has(key)) mismatches.push({ key, problem: 'served by the deployment, absent from the checkout' });
  }
  const localRevisionKey = [...tree.entries.keys()].find((key) => key.endsWith('/revision.json'));
  const localRevision = localRevisionKey?.split('/').at(-2);
  const sameRevision = localRevision === report.revision;
  return {
    root: tree.root,
    revision: localRevision ?? null,
    sameRevision,
    // A checkout that predates the deployment is a stale workspace, not a broken deployment: it is
    // only fatal when the caller says the checkout IS the expected source of truth.
    fatal: requireLocal ? mismatches.length > 0 || !sameRevision : sameRevision && mismatches.length > 0,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Full-tree verification of one deployment
// ---------------------------------------------------------------------------

export async function verifyDeployment(baseUrl, options = {}) {
  const settings = {
    concurrency: 8,
    timeoutMs: 30_000,
    retries: 4,
    headAll: false,
    localTree: undefined,
    requireLocal: false,
    onArtifact: undefined,
    ...options,
  };
  const request = settings.request ?? createFetcher(baseUrl, settings);
  const startedAt = new Date();
  const problems = [];
  const artifacts = [];
  // Declared up here (not at the probe step) so the early returns below can build a report.
  let probes = [];
  const record = (artifact) => {
    artifacts.push(artifact);
    settings.onArtifact?.(artifact);
    return artifact;
  };

  // 1. Discovery: the only entry point a client is allowed to hardcode.
  const discovery = record(await probeArtifact(request, DISCOVERY_ARTIFACT_KEY));
  const discoveryDocument = parseJsonBody(discovery);
  let latestKey = LATEST_ARTIFACT_KEY;
  if (discoveryDocument) {
    if (discoveryDocument.protocol !== 'vgpu-examples') problems.push(`discovery.protocol != "vgpu-examples"`);
    const contract = Array.isArray(discoveryDocument.contracts)
      ? discoveryDocument.contracts.find((entry) => entry?.id === CONTRACT_ID)
      : undefined;
    if (!contract) problems.push(`discovery does not advertise the ${CONTRACT_ID} contract`);
    else {
      if (contract.status !== 'active') problems.push(`discovery contract status is ${contract.status}, not "active"`);
      const key = keyFromReferencedUrl(contract.indexUrl, problems, 'discovery.contracts[].indexUrl');
      if (key) latestKey = key;
      if (key && key !== LATEST_ARTIFACT_KEY) problems.push(`discovery points at ${key}, expected ${LATEST_ARTIFACT_KEY}`);
    }
  }

  // 2. Latest pointer -> revision + the index digest that anchors the whole tree.
  const latest = record(await probeArtifact(request, latestKey));
  const latestDocument = parseJsonBody(latest);
  const revision = typeof latestDocument?.revision === 'string' ? latestDocument.revision : undefined;
  if (!revision || !SHA256_HEX.test(revision)) {
    problems.push(`latest.json has no valid revision (${JSON.stringify(latestDocument?.revision ?? null)})`);
    return finish();
  }
  if (latestDocument.contractId !== CONTRACT_ID) problems.push(`latest.contractId != ${CONTRACT_ID}`);
  const prefix = revisionArtifactKeyPrefix(revision);
  const indexKeyFromLatest = keyFromReferencedUrl(latestDocument.indexUrl, problems, 'latest.indexUrl');
  if (indexKeyFromLatest && indexKeyFromLatest !== `${prefix}/index.json`) {
    problems.push(`latest.indexUrl points at ${indexKeyFromLatest}, expected ${prefix}/index.json`);
  }

  // 3. Revision manifest: the declared size/sha256/content-type of every object in the tree.
  const revisionKey = `${prefix}/revision.json`;
  const revisionArtifact = record(await probeArtifact(request, revisionKey));
  const revisionDocument = parseJsonBody(revisionArtifact);
  if (revisionDocument?.revision !== revision) problems.push(`revision.json declares ${revisionDocument?.revision}, latest says ${revision}`);
  const objects = Array.isArray(revisionDocument?.objects) ? revisionDocument.objects : [];
  if (objects.length === 0) {
    problems.push('revision.json declares no objects');
    return finish();
  }
  const declared = new Map();
  for (const object of objects) {
    if (!object || typeof object.key !== 'string' || !SHA256_HEX.test(object.sha256 ?? '') ||
        !Number.isSafeInteger(object.size) || typeof object.contentType !== 'string') {
      problems.push(`revision.json has an invalid object entry: ${JSON.stringify(object)}`);
      continue;
    }
    if (!object.key.startsWith(`${prefix}/`)) problems.push(`revision.json object outside the revision prefix: ${object.key}`);
    declared.set(object.key, { size: object.size, sha256: object.sha256, contentType: object.contentType, anchoredBy: 'revision.json' });
  }

  // 4. Index: doubly anchored (revision.json AND latest.indexSha256).
  const indexKey = `${prefix}/index.json`;
  if (!declared.has(indexKey)) problems.push(`revision.json does not declare ${indexKey}`);
  const index = record(await probeArtifact(request, indexKey, declared.get(indexKey)));
  if (typeof latestDocument.indexSha256 === 'string' && latestDocument.indexSha256 !== index.sha256) {
    index.ok = false;
    index.problems.push(`sha256 ${index.sha256} != latest.indexSha256 ${latestDocument.indexSha256}`);
  }
  const indexDocument = parseJsonBody(index);
  if (indexDocument && indexDocument.revision !== revision) problems.push(`index.revision != ${revision}`);

  // 5. Manifests, then every file they reference. Fetched in dependency order so a manifest's
  //    declarations are cross-checked against the revision manifest before the files are pulled.
  const referenced = new Set([indexKey]);
  const manifestKeys = [];
  // The index carries its own hash and file count for every manifest, independently of
  // revision.json — a third anchor, so keep it.
  const indexAnchors = new Map();
  for (const entry of Array.isArray(indexDocument?.examples) ? indexDocument.examples : []) {
    const key = keyFromReferencedUrl(entry?.manifestUrl, problems, `index.examples[${entry?.id}].manifestUrl`);
    if (!key) continue;
    if (!declared.has(key)) problems.push(`index references an undeclared manifest: ${key}`);
    indexAnchors.set(key, { manifestSha256: entry?.manifestSha256, fileCount: entry?.fileCount });
    manifestKeys.push(key);
    referenced.add(key);
  }
  if (manifestKeys.length === 0) problems.push('index.json lists no examples');

  const manifests = await mapWithConcurrency(manifestKeys, settings.concurrency, (key) =>
    probeArtifact(request, key, declared.get(key)),
  );
  const fileKeys = [];
  for (const manifest of manifests) {
    record(manifest);
    const document = parseJsonBody(manifest);
    const anchor = indexAnchors.get(manifest.key);
    if (typeof anchor?.manifestSha256 === 'string' && anchor.manifestSha256 !== manifest.sha256) {
      manifest.ok = false;
      manifest.problems.push(`sha256 ${manifest.sha256} != index.manifestSha256 ${anchor.manifestSha256}`);
    }
    const fileCount = Array.isArray(document?.files) ? document.files.length : undefined;
    if (Number.isSafeInteger(anchor?.fileCount) && anchor.fileCount !== fileCount) {
      problems.push(`${manifest.key}: index says fileCount ${anchor.fileCount}, the manifest lists ${fileCount}`);
    }
    if (document && document.revision !== revision) problems.push(`${manifest.key}: revision != ${revision}`);
    for (const file of Array.isArray(document?.files) ? document.files : []) {
      const key = keyFromReferencedUrl(file?.url, problems, `${manifest.key}.files[].url`);
      if (!key) continue;
      const declaration = declared.get(key);
      if (!declaration) {
        problems.push(`${manifest.key} references an undeclared file: ${key}`);
      } else {
        // The manifest and the revision manifest are two independent declarations of the same
        // bytes; if they disagree, no fetch can be trusted.
        if (file.sha256 !== declaration.sha256) problems.push(`${key}: manifest sha256 != revision.json sha256`);
        if (file.size !== declaration.size) problems.push(`${key}: manifest size != revision.json size`);
      }
      fileKeys.push(key);
      referenced.add(key);
    }
  }

  const files = await mapWithConcurrency(fileKeys, settings.concurrency, (key) =>
    probeArtifact(request, key, declared.get(key)),
  );
  for (const file of files) record(file);

  // 6. Closure: nothing declared may be unreachable, nothing served may be undeclared.
  for (const key of declared.keys()) {
    if (!referenced.has(key)) problems.push(`revision.json declares an object no document references: ${key}`);
  }

  // 7. Contract probes on the entry documents: HEAD and conditional GET are part of the published
  //    contract (`Access-Control-Allow-Methods: GET, HEAD, OPTIONS`), and a deployment that serves
  //    the right bytes but breaks caching is not at parity.
  const probeKeys = settings.headAll ? artifacts.map((artifact) => artifact.key) : [DISCOVERY_ARTIFACT_KEY, latestKey, indexKey];
  const byKey = new Map(artifacts.map((artifact) => [artifact.key, artifact]));
  probes = await mapWithConcurrency(probeKeys, settings.concurrency, async (key) => {
    const artifact = byKey.get(key);
    const path = artifactPathForKey(key);
    const problemsForProbe = [];
    const head = await request(path, { method: 'HEAD' });
    if (head.status !== 200) problemsForProbe.push(`HEAD ${path}: HTTP ${head.status}`);
    if (Number(head.headers.get('content-length')) !== artifact.bytes) {
      problemsForProbe.push(`HEAD ${path}: content-length ${head.headers.get('content-length')} != ${artifact.bytes}`);
    }
    if (head.headers.get('content-type') !== artifact.contentType) {
      problemsForProbe.push(`HEAD ${path}: content-type differs from GET`);
    }
    const conditional = await request(path, { method: 'GET', headers: { 'if-none-match': `"${artifact.sha256}"` } });
    if (conditional.status !== 304) problemsForProbe.push(`If-None-Match ${path}: expected 304, got ${conditional.status}`);
    return { key, ok: problemsForProbe.length === 0, problems: problemsForProbe };
  });
  for (const probe of probes) {
    if (!probe.ok) problems.push(...probe.problems);
  }

  return finish();

  function finish() {
    for (const artifact of artifacts) delete artifact.body;
    artifacts.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const finishedAt = new Date();
    const failed = artifacts.filter((artifact) => !artifact.ok);
    const report = {
      tool: 'verify-examples-api-deployment',
      reportVersion: 1,
      baseUrl,
      revision: revision ?? null,
      contractId: CONTRACT_ID,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      counts: {
        total: artifacts.length,
        ok: artifacts.length - failed.length,
        failed: failed.length,
        byKind: countByKind(artifacts),
      },
      artifacts,
      probes: typeof probes === 'undefined' ? [] : probes,
      problems,
      localTree: null,
      ok: failed.length === 0 && problems.length === 0,
    };
    return report;
  }
}

function countByKind(artifacts) {
  const counts = {};
  for (const artifact of artifacts) counts[artifact.kind] = (counts[artifact.kind] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatArtifactLine(artifact) {
  const status = artifact.ok ? 'ok  ' : 'FAIL';
  const size = String(artifact.bytes).padStart(8);
  return `  ${status} ${size}B  ${artifact.sha256.slice(0, 12)}  ${artifact.path}`;
}

export function formatReport(report, { verbose = false } = {}) {
  const lines = [];
  lines.push(`# ${report.baseUrl}`);
  lines.push(`  revision   ${report.revision ?? '(none)'}`);
  lines.push(`  artifacts  ${report.counts.total} (${JSON.stringify(report.counts.byKind)})`);
  for (const artifact of report.artifacts) {
    if (verbose || !artifact.ok) lines.push(formatArtifactLine(artifact));
    if (!artifact.ok) for (const problem of artifact.problems) lines.push(`         - ${problem}`);
  }
  for (const problem of report.problems) lines.push(`  ! ${problem}`);
  if (report.localTree) {
    lines.push(`  local tree ${report.localTree.root}`);
    lines.push(`             revision ${report.localTree.revision ?? '(none)'} — ${report.localTree.sameRevision ? 'same as the deployment' : 'DIFFERENT from the deployment'}`);
    for (const mismatch of report.localTree.mismatches) lines.push(`         - ${mismatch.key}: ${mismatch.problem}`);
  }
  lines.push(`  verdict    ${report.ok ? 'PASS' : 'FAIL'} — ${report.counts.ok}/${report.counts.total} artifacts verified byte-for-byte`);
  return lines.join('\n');
}

export function formatComparison(comparison, a, b) {
  const lines = [];
  lines.push('# A/B parity');
  lines.push(`  A  ${a.baseUrl}`);
  lines.push(`  B  ${b.baseUrl}`);
  for (const difference of comparison.differences.slice(0, 50)) {
    lines.push(`  ! ${JSON.stringify(difference)}`);
  }
  if (comparison.differences.length > 50) lines.push(`  ! ... and ${comparison.differences.length - 50} more differences`);
  lines.push(`  verdict    ${comparison.equal ? 'PASS' : 'FAIL'} — ${comparison.equal ? 'both deployments serve the same tree, byte for byte' : `${comparison.differences.length} differences`}`);
  return lines.join('\n');
}

const USAGE = `Usage:
  node scripts/verify-examples-api-deployment.mjs <baseUrl> [<baseUrlB>] [options]

Verifies every artifact of the vgpu examples API served by a deployment (discovery, latest
pointer, revision manifest, index, every example manifest and every source file) against the
sizes, content types and sha256 digests the deployment itself declares, and — with two URLs —
that both deployments serve exactly the same tree.

Options:
  --compare <url>     second deployment (same as a second positional URL)
  --local[=<dir>]     cross-check against a generated tree in the checkout
                      (default ${DEFAULT_LOCAL_TREE})
  --require-local     a local-tree revision mismatch becomes a failure
  --json <file>       write the machine-readable report
  --concurrency <n>   parallel requests (default 8)
  --timeout <ms>      per-request timeout (default 30000)
  --retries <n>       retries for transient failures (default 4)
  --head-all          send HEAD + conditional GET probes for every artifact
  --verbose           one line per artifact
  --help

Exit codes: 0 pass, 1 parity/integrity failure, 2 usage error, 75 BLOCKED (inconclusive).`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`verify-examples-api-deployment: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_PASS;
  }

  const tree = options.localTree ? await loadLocalTree(options.localTree) : undefined;
  const reports = [];
  for (const baseUrl of options.urls) {
    console.log(`verify-examples-api-deployment: walking ${baseUrl} ...`);
    const report = await verifyDeployment(baseUrl, options);
    if (tree) {
      report.localTree = crossCheckLocalTree(tree, report, options.requireLocal);
      if (report.localTree.fatal) report.ok = false;
    }
    reports.push(report);
    console.log(formatReport(report, { verbose: options.verbose }));
  }

  const comparison = reports.length === 2 ? compareReports(reports[0], reports[1]) : undefined;
  if (comparison) console.log(formatComparison(comparison, reports[0], reports[1]));

  if (options.jsonPath) {
    const document = comparison
      ? { mode: 'ab', a: reports[0], b: reports[1], comparison }
      : { mode: 'single', ...reports[0] };
    await writeFile(resolve(process.cwd(), options.jsonPath), `${JSON.stringify(document, null, 2)}\n`);
    console.log(`verify-examples-api-deployment: report written to ${options.jsonPath}`);
  }

  const passed = reports.every((report) => report.ok) && (comparison ? comparison.equal : true);
  console.log(`verify-examples-api-deployment: ${passed ? 'PASS' : 'FAIL'}`);
  return passed ? EXIT_PASS : EXIT_FAIL;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof BlockedError) {
      const advice = {
        'deployment-protection':
          'The deployment is behind Vercel Deployment Protection. Set VERCEL_AUTOMATION_BYPASS_SECRET\n' +
          '(Project Settings -> Deployment Protection -> Protection Bypass for Automation) and re-run.\n',
        'bot-mitigation':
          "Vercel's anti-bot mitigation is transient and unrelated to the artifact bytes: wait a few\n" +
          'minutes and re-run (the script already backs off), or re-run from a different network.\n',
        network: 'The URL was unreachable (DNS, TLS, timeout or a closed port). Check the URL and the network.\n',
      };
      console.error(
        `verify-examples-api-deployment: BLOCKED — ${error.message}\n` +
          'This is NOT a parity failure: the deployment could not be interrogated.\n' +
          (advice[error.detail?.reason] ?? ''),
      );
      process.exitCode = EXIT_BLOCKED;
    } else {
      console.error(`verify-examples-api-deployment: ${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = EXIT_FAIL;
    }
  }
}
