import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

/** Maintainer transport only. The caller supplies the reviewed artifact identity. */
export async function downloadVerifiedAsset({
  url,
  expected,
  destination,
  fetch: fetchAsset = globalThis.fetch,
}) {
  const response = await fetchAsset(url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Compiler asset download failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Compiler asset response has no body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > expected.bytes) {
      throw new Error("Compiler asset response exceeds locked size");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  ) {
    throw new Error(
      "Compiler asset does not match its locked bytes and SHA-256"
    );
  }
  await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
}
