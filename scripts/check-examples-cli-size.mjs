import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "../packages/vgpu/lib/examples");
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(resolve(path, entry.name)) : [resolve(path, entry.name)]))).flat();
}
const paths = (await files(root)).sort();
const chunks = await Promise.all(paths.map((path) => readFile(path)));
const unpacked = chunks.reduce((sum, bytes) => sum + bytes.length, 0);
const gzip = gzipSync(Buffer.concat(chunks), { level: 9 }).length;
const limits = { unpacked: 100 * 1024, gzip: 30 * 1024 };
console.log(`examples CLI: ${unpacked} B unpacked / ${gzip} B gzip (${paths.length} files)`);
if (unpacked > limits.unpacked || gzip > limits.gzip) {
  console.error(`Examples CLI exceeds budget: ${limits.unpacked} B unpacked / ${limits.gzip} B gzip`);
  process.exitCode = 1;
}
