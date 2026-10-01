import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(repoRoot, "apps/docs");
const exampleDir = join(repoRoot, "examples/next-wgsl");
const fingerprintHelper = join(repoRoot, "scripts/lib/wgsl-loader-fingerprint.mjs");
const fixtureRoot = await mkdtemp(join(docsDir, ".wgsl-cache-replay-"));
const outputDir = join(fixtureRoot, ".next");
const cacheDir = join(outputDir, "cache");
const pageHtml = join(outputDir, "server/app/index.html");
const cacheSnapshotRoot = await mkdtemp(join(docsDir, ".wgsl-cache-snapshot-"));
const cacheSnapshot = join(cacheSnapshotRoot, "cache");
const requireFromDocs = createRequire(join(docsDir, "package.json"));
const installedLoaderPath = requireFromDocs.resolve("@vgpu/wgsl/loader-webpack");
const installedWgslRoot = resolve(dirname(installedLoaderPath), "../..");
const fixtureWgslRoot = join(fixtureRoot, "node_modules/@vgpu/wgsl");
const loaderPath = join(fixtureWgslRoot, "dist/loader-webpack/index.js");
const producerPath = join(fixtureWgslRoot, "dist/loader-shared/emit.js");
const nextPackage = dirname(requireFromDocs.resolve("next/package.json"));
const nextBinary = join(nextPackage, "dist/bin/next");
const prepareLine = "const prepared = prepareShader({ wgsl, functionExports }, path);";

try {
  await writeFixture();
  const currentProducer = await readFile(producerPath, "utf8");
  if (!currentProducer.includes(prepareLine)) {
    throw new Error(`Could not locate the prepared artifact producer in ${producerPath}`);
  }
  const staleProducer = currentProducer.replace(
    prepareLine,
    "const prepared = { ...prepareShader({ wgsl, functionExports }, path), version: 1 };",
  );
  await writeFile(join(fixtureRoot, "expected-artifact.json"), JSON.stringify(await expectedArtifact()));

  await writeFile(producerPath, staleProducer);
  await nextBuild("warm fixture-local v1 producer");
  await assertRenderedArtifact(1, "rejected");
  await stat(cacheDir);
  await cp(cacheDir, cacheSnapshot, { recursive: true, preserveTimestamps: true });

  // Match a restored deployment cache: prior output chunks do not survive, only
  // Next's persistent cache is placed into the otherwise fresh build directory.
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(cacheSnapshot, cacheDir, { recursive: true, preserveTimestamps: true });

  await writeFile(producerPath, currentProducer);
  await nextBuild("same-path fixture-local v2 producer");
  await assertRenderedArtifact(2, "accepted");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(cacheSnapshotRoot, { recursive: true, force: true });
}

console.log("Next 16 restored cache rebuilt the isolated same-path WGSL producer: v1 -> exact v2.");

async function writeFixture() {
  const appDir = join(fixtureRoot, "app");
  await Promise.all([
    mkdir(appDir, { recursive: true }),
    mkdir(join(fixtureWgslRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(fixtureRoot, "package.json"), '{"private":true,"type":"module"}\n'),
    writeFile(join(fixtureRoot, "next.config.mjs"), nextConfigSource()),
    writeFile(join(appDir, "layout.jsx"), "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n"),
    writeFile(join(appDir, "page.jsx"), `import shader from "./shader.wgsl";
import expected from "../expected-artifact.json";
export default function Page() {
  const accepted = JSON.stringify(shader) === JSON.stringify(expected);
  return <main data-shader-version={String(shader.version)} data-shader-consumer={accepted ? "accepted" : "rejected"}>
    <h1>WGSL cache replay</h1><pre>{shader.wgsl}</pre>
  </main>;
}
`),
    cp(join(exampleDir, "app/shader.wgsl"), join(appDir, "shader.wgsl")),
    cp(join(exampleDir, "app/helper.wgsl"), join(appDir, "helper.wgsl")),
    cp(join(installedWgslRoot, "package.json"), join(fixtureWgslRoot, "package.json")),
    cp(join(installedWgslRoot, "dist"), join(fixtureWgslRoot, "dist"), { recursive: true }),
    cp(join(installedWgslRoot, "src/metadata.wgsl"), join(fixtureWgslRoot, "src/metadata.wgsl")),
  ]);
}

async function expectedArtifact() {
  const shaderPath = join(fixtureRoot, "app/shader.wgsl");
  const { resolveShader } = await import(pathToFileURL(join(fixtureWgslRoot, "dist/runtime/resolve-shader.js")).href);
  const { prepareShader } = await import(pathToFileURL(join(fixtureWgslRoot, "dist/prepare.js")).href);
  const resolved = await resolveShader({ entry: shaderPath, validate: false });
  return prepareShader({ wgsl: resolved.wgsl, functionExports: resolved.functionExports }, shaderPath);
}

function nextConfigSource() {
  return `import { createRequire } from "node:module";
import { wgslLoaderFingerprint } from ${JSON.stringify(pathToFileURL(fingerprintHelper).href)};
const require = createRequire(import.meta.url);
const wgslLoader = require.resolve("@vgpu/wgsl/loader-webpack");
const wgslLoaderCacheKey = wgslLoaderFingerprint(wgslLoader);
export default {
  turbopack: {
    root: ${JSON.stringify(repoRoot)},
    rules: {
      "*.wgsl": {
        loaders: [{
          loader: wgslLoader,
          options: { vgpuImplementationFingerprint: wgslLoaderCacheKey },
        }],
        as: "*.js",
      },
    },
  },
};
`;
}

async function nextBuild(label) {
  console.log(`\n[wgsl-cache] ${label}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [nextBinary, "build", fixtureRoot, "--turbopack"], {
      cwd: repoRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Next build failed (${signal ?? `exit ${String(code)}`}) during ${label}`));
    });
  });
}

async function assertRenderedArtifact(version, consumer) {
  const html = await readFile(pageHtml, "utf8");
  const expectedVersion = `data-shader-version="${version}"`;
  const expectedConsumer = `data-shader-consumer="${consumer}"`;
  if (!html.includes(expectedVersion) || !html.includes(expectedConsumer)) {
    throw new Error(
      `Expected ${expectedVersion} and ${expectedConsumer} in ${pageHtml}`,
    );
  }
  if (!html.includes("0.1, 0.2, 0.3")) {
    throw new Error(`Expected resolved helper WGSL in ${pageHtml}`);
  }
}
