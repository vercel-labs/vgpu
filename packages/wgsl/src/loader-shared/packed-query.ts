import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { decodePackedMetadata } from "../packed/decode.ts";
import { invalidPackedMetadata, type PackedTable } from "../packed/format.ts";

export const PACKED_QUERY_KEY = "__vgpu_packed_v1";
export const PACKED_QUERY_MAX_BYTES = 4096;

const PACKED_QUERY_PREFIX = "__vgpu_packed_";
const require = createRequire(import.meta.url);
let assets: { readonly decoder: string; readonly anchor: string } | undefined;

export function packedModuleAssets(): { readonly decoder: string; readonly anchor: string } {
  return assets ??= {
    decoder: resolvePackageAsset("@vgpu/wgsl/_packed"),
    anchor: resolvePackageAsset("@vgpu/wgsl/_metadata.wgsl"),
  };
}

export function encodePackedQuery(table: PackedTable): string | null {
  decodePackedMetadata(table);
  const payload = Buffer.from(JSON.stringify(table), "utf8").toString("base64url");
  const query = `?${PACKED_QUERY_KEY}=${payload}`;
  return Buffer.byteLength(query, "ascii") <= PACKED_QUERY_MAX_BYTES ? query : null;
}

export function packedQueryModule(resourcePath: string, resourceQuery: string): string | null {
  if (!containsReservedQuery(resourceQuery)) return null;
  const payload = parseReservedQuery(resourceQuery);
  if (!sameAsset(resourcePath, packedModuleAssets().anchor)) throw invalidPackedMetadata("anchor");

  let json: string;
  let table: unknown;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== payload) throw new Error("base64");
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    table = JSON.parse(json);
    if (Buffer.from(JSON.stringify(table), "utf8").toString("base64url") !== payload) throw new Error("canonical");
  } catch {
    throw invalidPackedMetadata("query");
  }

  decodePackedMetadata(table);
  return `export default ${json};`;
}

function parseReservedQuery(resourceQuery: string): string {
  if (
    !resourceQuery.startsWith("?")
    || Buffer.byteLength(resourceQuery, "utf8") > PACKED_QUERY_MAX_BYTES
    || !/^[\x20-\x7e]+$/u.test(resourceQuery)
    || resourceQuery.includes("#")
    || resourceQuery.includes("&")
  ) throw invalidPackedMetadata("query");

  const equals = resourceQuery.indexOf("=");
  if (equals < 0 || resourceQuery.indexOf("=", equals + 1) >= 0) throw invalidPackedMetadata("query");
  const key = resourceQuery.slice(1, equals);
  const payload = resourceQuery.slice(equals + 1);
  if (key !== PACKED_QUERY_KEY || !/^[A-Za-z0-9_-]+$/u.test(payload)) {
    throw invalidPackedMetadata("query");
  }
  return payload;
}

function containsReservedQuery(resourceQuery: string): boolean {
  const body = resourceQuery.startsWith("?") ? resourceQuery.slice(1) : resourceQuery;
  for (const part of body.split(/[&#]/u)) {
    const rawKey = part.split("=", 1)[0] ?? "";
    if (rawKey.includes(PACKED_QUERY_PREFIX)) return true;
    try {
      if (decodeURIComponent(rawKey).startsWith(PACKED_QUERY_PREFIX)) return true;
    } catch {
      const repaired = rawKey.replace(/%(?![0-9a-f]{2}).{0,2}/giu, "");
      try {
        if (decodeURIComponent(repaired).startsWith(PACKED_QUERY_PREFIX)) return true;
      } catch {
        // A malformed unrelated key retains the existing loader route.
      }
    }
  }
  return false;
}

function resolvePackageAsset(specifier: string): string {
  return normalizePath(realpathSync.native(require.resolve(specifier)));
}

function sameAsset(resourcePath: string, expected: string): boolean {
  let candidate = normalizePackedResourcePath(resourcePath);
  try {
    candidate = normalizePath(realpathSync.native(resolve(candidate)));
  } catch {
    candidate = normalizePath(resolve(candidate));
  }
  return candidate === expected;
}

export function normalizePackedResourcePath(path: string): string {
  let normalized = normalizePath(path);
  if (!normalized.startsWith("/@fs/")) return normalized;
  normalized = normalized.slice(5);
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/");
}
