#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { resolveShader as productionResolveShader } from "../../../../packages/wgsl/dist/runtime/resolve-shader.js";

import {
  canonicalRequestHash,
  canonicalVirtualId,
  canonicalizePackageMap,
  createVirtualModules,
  resolveVirtualShader,
} from "./virtual-resolver.mjs";

const source = (id, virtualPath, text) => ({
  id,
  virtualPath,
  text,
  sha256: createHash("sha256").update(text, "utf8").digest("hex"),
});

const sources = [
  source(
    "entry-wgsl",
    "Shaders/main.wgsl",
    `import { tone } from "./lib/tone.wgsl";
override GAIN: f32 = 1.0;
@fragment fn fs_main() -> @location(0) vec4f { return tone(GAIN); }`
  ),
  source(
    "tone-wgsl",
    "Shaders/lib/tone.wgsl",
    `export fn dead(
  value: f32,
) -> f32 {
  return value;
}

export fn tone(value: f32) -> vec4f {
  return vec4f(value, 0.0, 0.0, 1.0);
}`
  ),
];

const first = await resolveVirtualShader({
  entry: "Shaders/main.wgsl",
  generatedVirtualPath: "Intermediate/main.fragment.resolved.wgsl",
  sources,
});
const reordered = await resolveVirtualShader({
  entry: "Shaders/main.wgsl",
  generatedVirtualPath: "Intermediate/main.fragment.resolved.wgsl",
  sources: [...sources].reverse(),
});

assert.equal(
  Object.getPrototypeOf(createVirtualModules(sources).modules),
  null
);
assert.equal(first.resolved.wgsl, reordered.resolved.wgsl);
assert.deepEqual(first.resolved.deps, reordered.resolved.deps);
assert.deepEqual(first.requestHash, reordered.requestHash);
assert.deepEqual(first.originMap, reordered.originMap);
assert.match(first.resolved.wgsl, /_vgsl_[a-f0-9]{8}__tone/u);
assert.doesNotMatch(JSON.stringify(first), /\/Users\/|\/tmp\/|[A-Za-z]:\\/u);

const physicalResolution = async (root) => {
  const modules = Object.fromEntries(
    sources.map((item) => [`${root}/${item.virtualPath}`, item.text])
  );
  return productionResolveShader({
    entry: `${root}/Shaders/main.wgsl`,
    rootDir: root,
    modules,
    validate: false,
    minify: false,
  });
};
const physicalA = await physicalResolution("/tmp/checkout-alpha");
const physicalB = await physicalResolution("/private/tmp/checkout-beta");
assert.notEqual(
  physicalA.wgsl,
  physicalB.wgsl,
  "physical module identities must remain a negative control"
);

const authoredToneLine = sources[1].text
  .slice(0, sources[1].text.indexOf("export fn tone"))
  .split("\n").length;
const generatedToneLine = first.resolved.wgsl
  .slice(0, first.resolved.wgsl.indexOf("__tone"))
  .split("\n").length;
assert.notEqual(
  generatedToneLine,
  authoredToneLine,
  "the DCE canary must keep generated and authored lines observably distinct"
);

const originSchema = JSON.parse(
  await readFile(
    new URL("../contracts/origin-map-v1.schema.json", import.meta.url),
    "utf8"
  )
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateOriginMap = ajv.compile(originSchema);
assert.equal(
  validateOriginMap(first.originMap),
  true,
  JSON.stringify(validateOriginMap.errors)
);
assert.ok(first.originMap.segments.length >= 2);
for (const segment of first.originMap.segments) {
  assert.deepEqual(Object.keys(segment.origin), ["input"]);
  assert.equal(segment.precision, "module");
  assert.equal("line" in segment.generated, false);
  assert.equal("column" in segment.generated, false);
  const bytes = Buffer.from(first.resolved.wgsl, "utf8").subarray(
    segment.generated.startByte,
    segment.generated.endByte
  );
  assert.doesNotMatch(bytes.toString("utf8"), /^\/\/ vgsl-module:/u);
}

assert.equal(
  canonicalVirtualId("Cafe\u0301/shader.wgsl"),
  "Caf\u00e9/shader.wgsl"
);
for (const invalid of [
  "/absolute.wgsl",
  "C:/absolute.wgsl",
  "file://host/shader.wgsl",
  "file:/host/shader.wgsl",
  "HTTPS://host/shader.wgsl",
  "bad-\ud800.wgsl",
  "a\\b.wgsl",
  "a/./b.wgsl",
  "a/../b.wgsl",
  "a//b.wgsl",
]) {
  assert.throws(() => canonicalVirtualId(invalid));
}
assert.throws(
  () =>
    createVirtualModules([
      source("upper", "Shaders/A.wgsl", "fn a() {}"),
      source("lower", "shaders/a.wgsl", "fn b() {}"),
    ]),
  { code: "VGPU-C1-RESOLVER-SOURCE-CASE-COLLISION" }
);
assert.throws(
  () =>
    canonicalizePackageMap({
      "@scope/pkg": "Vendor/broad",
      "@scope/pkg/sub": "Vendor/narrow",
    }),
  { code: "VGPU-C1-RESOLVER-PACKAGE-OVERLAP" }
);
assert.throws(
  () =>
    createVirtualModules([
      source(
        "spoof",
        "Shaders/spoof.wgsl",
        "// vgsl-module: Shaders/other.wgsl\nfn main() {}"
      ),
    ]),
  { code: "VGPU-C1-RESOLVER-HEADER-SPOOF" }
);
assert.throws(
  () =>
    createVirtualModules([
      {
        ...source("bad-hash", "Shaders/hash.wgsl", "fn main() {}"),
        sha256: "0".repeat(64),
      },
    ]),
  { code: "VGPU-C1-RESOLVER-SOURCE-HASH-MISMATCH" }
);
for (const id of [
  "\\\\server\\share\\shader.wgsl",
  "\\\\?\\C:\\shader.wgsl",
  "file:/host/shader.wgsl",
  "bad-\ud800",
]) {
  assert.throws(
    () => createVirtualModules([source(id, "Shaders/id.wgsl", "fn f() {}")]),
    { code: "VGPU-C1-RESOLVER-INPUT-ID" }
  );
}
assert.throws(
  () =>
    createVirtualModules([
      source("invalid-unicode", "Shaders/unicode.wgsl", "\ud800"),
    ]),
  { code: "VGPU-C1-RESOLVER-SOURCE-UNICODE" }
);
assert.throws(() => canonicalRequestHash({ value: "\ud800" }), {
  code: "VGPU-C1-RESOLVER-HASH-UNICODE",
});

await assert.rejects(
  resolveVirtualShader({
    entry: "Shaders/main.wgsl",
    sources: [
      source(
        "missing-import",
        "Shaders/main.wgsl",
        'import { absent } from "./absent.wgsl"; fn main() { absent(); }'
      ),
    ],
  }),
  { code: "VGPU-WGSL-RES-NOTFOUND" }
);
for (const [sourceText, code] of [
  [
    'import { absent } from "/host/absolute.wgsl"; fn main() { absent(); }',
    "VGPU-WGSL-RES-ABS",
  ],
  [
    'import { absent } from "../../../host/escape.wgsl"; fn main() { absent(); }',
    "VGPU-WGSL-RES-NOTFOUND",
  ],
  [
    'import { absent } from "unmapped-package/value"; fn main() { absent(); }',
    "VGPU-WGSL-PKG-NOTFOUND",
  ],
]) {
  await assert.rejects(
    resolveVirtualShader({
      entry: "Shaders/main.wgsl",
      sources: [source("invalid-import", "Shaders/main.wgsl", sourceText)],
    }),
    { code }
  );
}
await assert.rejects(
  resolveVirtualShader({
    entry: "Shaders/main.wgsl",
    generatedVirtualPath: "shaders/MAIN.wgsl",
    sources: [
      source(
        "same-path",
        "Shaders/main.wgsl",
        "@compute @workgroup_size(1) fn main() {}"
      ),
    ],
  }),
  { code: "VGPU-C1-RESOLVER-GENERATED-COLLISION" }
);

const emptyModule = await resolveVirtualShader({
  entry: "Shaders/empty.wgsl",
  sources: [source("empty-wgsl", "Shaders/empty.wgsl", "")],
});
assert.match(
  emptyModule.resolved.wgsl,
  /^\/\/ vgsl-module: Shaders\/empty\.wgsl/mu
);
assert.deepEqual(emptyModule.originMap.segments, []);
assert.deepEqual(emptyModule.originMap.sources, [
  {
    input: "empty-wgsl",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
]);

const hashA = canonicalRequestHash({ z: 1, nested: { b: 2, a: 1 } });
const hashB = canonicalRequestHash({ nested: { a: 1, b: 2 }, z: 1 });
const hashChanged = canonicalRequestHash({ nested: { a: 1, b: 3 }, z: 1 });
assert.deepEqual(hashA, hashB);
assert.notDeepEqual(hashA, hashChanged);

console.log(
  `PASS virtual resolver: ${sources.length} modules, ${
    first.originMap.segments.length
  } module-precision segments, relocatable request ${first.requestHash.sha256.slice(
    0,
    12
  )}`
);
