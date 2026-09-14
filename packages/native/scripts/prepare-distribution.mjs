import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Maintainer-only packaging: use accepted local inputs, never rebuild or download a worker.
const source = new URL(
  "../../../tooling/native-tint-worker/c1-tint-direct-build/",
  import.meta.url
);
const provenance = new URL("provenance/", source);
const jsoncppProvenance = new URL(
  "../c1-compiler-protocol/provenance/",
  source
);
const lock = JSON.parse(
  await readFile(new URL("source-lock.json", provenance), "utf8")
);
const jsoncpp = JSON.parse(
  await readFile(new URL("jsoncpp-1.9.8.json", jsoncppProvenance), "utf8")
);
const assets = [
  {
    path: "vgpu-tint-worker",
    source: new URL(".artifacts/bin/vgpu-tint-worker-universal", source),
    expected: lock.build.outputs.universal,
  },
  {
    path: "licenses/Dawn-Tint.txt",
    source: new URL(lock.dawn.license.trackedPath, provenance),
    expected: lock.dawn.license,
  },
  {
    path: "licenses/Abseil.txt",
    source: new URL(lock.dependencies.abseil.license.trackedPath, provenance),
    expected: lock.dependencies.abseil.license,
  },
  {
    path: "licenses/JsonCpp.txt",
    source: new URL(jsoncpp.license.trackedPath, jsoncppProvenance),
    expected: jsoncpp.license,
  },
];

// Authenticate every input once before touching distribution files. A stale asset is never a fallback.
const snapshots = [];
for (const asset of assets) {
  const bytes = await readFile(asset.source);
  verify(bytes, asset.expected, `accepted ${asset.path}`);
  snapshots.push({ ...asset, bytes });
}

const output = new URL("../dist/compiler/assets/darwin/", import.meta.url);
await mkdir(new URL("licenses/", output), { recursive: true });
for (const asset of snapshots) {
  const destination = new URL(asset.path, output);
  // These are private data files; execution uses the runtime's authenticated temporary snapshot.
  await writeFile(destination, asset.bytes, { mode: 0o644 });
  verify(await readFile(destination), asset.expected, `packaged ${asset.path}`);
}

function verify(bytes, expected, label) {
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error(
      `Native distribution ${label} does not match its locked bytes and SHA-256`
    );
}
