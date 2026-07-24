import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(root, process.env.VGPU_EXAMPLES_OUTPUT_DIR ?? 'apps/docs/generated/examples-api');
// Address the canonical source snapshot, not the generator commit (avoids self-changing output).
const commit = process.env.VGPU_EXAMPLES_GIT_COMMIT ?? execFileSync(
  'git', ['log', '-1', '--format=%H', '--', 'apps/docs/lib/examples-source.generated.ts'],
  { cwd: root, encoding: 'utf8' },
).trim();
const publish = process.argv.includes('--publish');
const deploymentUrl = process.env.VERCEL_DEPLOYMENT_URL;
if (publish && !deploymentUrl) throw new Error('Missing VERCEL_DEPLOYMENT_URL for pre-pointer verification');
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'vgpu-examples-generator-'));
const bundle = resolve(temporaryDirectory, 'run.mjs');
try {
  await rm(output, { recursive: true, force: true });
  await build({
    stdin: {
      contents: `
        import { exampleSources } from ${JSON.stringify(resolve(root, 'apps/docs/lib/examples-source.generated.ts'))};
        import { adaptCanonicalSourceExport } from ${JSON.stringify(resolve(root, 'apps/docs/lib/examples-api/adapter-v1.ts'))};
        import { generateExampleArtifacts, writeArtifactTree } from ${JSON.stringify(resolve(root, 'apps/docs/lib/examples-api/artifact-generator.ts'))};
        import { publishArtifactSet } from ${JSON.stringify(resolve(root, 'apps/docs/lib/examples-api/publisher.ts'))};
        import { VercelBlobPublisher } from ${JSON.stringify(resolve(root, 'apps/docs/lib/examples-api/vercel-blob-publisher.ts'))};
        import { sha256 } from ${JSON.stringify(resolve(root, 'apps/docs/lib/examples-api/hashing.ts'))};
        const graph = adaptCanonicalSourceExport(exampleSources, { repository: 'https://github.com/vgpu/vgpu', gitCommit: ${JSON.stringify(commit)} });
        const set = generateExampleArtifacts(graph, ${JSON.stringify(process.env.VGPU_EXAMPLES_ORIGIN ?? 'https://vgpu.labs.vercel.dev')});
        await writeArtifactTree(set, ${JSON.stringify(output)});
        const verifyDeployed = async ({ artifacts }) => {
          const deployment = new URL(${JSON.stringify(deploymentUrl ? (deploymentUrl.startsWith('http') ? deploymentUrl : `https://${deploymentUrl}`) : 'https://invalid.local')});
          const index = artifacts.find(({ key }) => key.endsWith('/index.json'));
          const indexDocument = JSON.parse(new TextDecoder().decode(index.bytes));
          const fractalIndex = indexDocument.examples.find(({ id }) => id === 'raymarched-fractal');
          const manifestPath = new URL(fractalIndex.manifestUrl).pathname;
          const manifest = artifacts.find(({ key }) => '/api/' + key === manifestPath);
          const manifestDocument = JSON.parse(new TextDecoder().decode(manifest.bytes));
          const filePath = new URL(manifestDocument.files[0].url).pathname;
          const file = artifacts.find(({ key }) => '/api/' + key === filePath);
          for (const artifact of [index, manifest, file]) {
            const response = await fetch(new URL('/api/' + artifact.key, deployment), { redirect: 'error', cache: 'no-store' });
            if (!response.ok || response.headers.get('content-type') !== (artifact.contentType.startsWith('text/') ? artifact.contentType + '; charset=utf-8' : artifact.contentType)) {
              throw new Error('Pre-pointer deployment verification failed: ' + artifact.key);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength !== artifact.bytes.byteLength || sha256(bytes) !== artifact.sha256) {
              throw new Error('Pre-pointer deployment integrity failed: ' + artifact.key);
            }
          }
        };
        if (${JSON.stringify(publish)}) await publishArtifactSet(new VercelBlobPublisher(), set, { beforeLatest: verifyDeployed });
        console.log(JSON.stringify({ revision: set.revision, artifacts: set.artifacts.length, published: ${JSON.stringify(publish)}, output: ${JSON.stringify(output)} }));
      `,
      resolveDir: root,
      sourcefile: 'generate-examples-api-runner.ts',
      loader: 'ts',
    },
    plugins: [{
      name: 'server-only-stub',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'server-only-stub' }));
        esbuild.onLoad({ filter: /.*/, namespace: 'server-only-stub' }, () => ({ contents: '' }));
      },
    }],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
  await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
