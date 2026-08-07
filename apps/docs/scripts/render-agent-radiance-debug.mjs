import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { writePng } from '@vgpu/cli/lib/snapshot/png.js';
import { transformWgsl } from '@vgpu/wgsl/loader-vite';
import { init, target } from 'vgpu/node';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = path.resolve(docsDir, '../..');
const outArgument = process.argv.find((argument) => argument.startsWith('--out='));
const outDir = path.resolve(workspaceDir, outArgument?.slice('--out='.length) || 'artifacts/agent-radiance-debug');
const qualityArgument = process.argv.find((argument) => argument.startsWith('--quality='));
const quality = qualityArgument?.slice('--quality='.length) || 'recording';
if (!['web', 'high', 'recording'].includes(quality)) {
  throw new Error(`Unknown quality "${quality}". Use web, high, or recording.`);
}
const cacheDir = path.join(docsDir, '.agent-radiance-debug-cache');
const entry = path.join(cacheDir, 'entry.ts');
const bundle = path.join(cacheDir, 'entry.mjs');
const width = 480;
const height = 270;

await mkdir(cacheDir, { recursive: true });
await mkdir(outDir, { recursive: true });
await writeFile(entry, "export { DEBUG_CAPTURES, renderDebugCaptures } from '../examples/agent-radiance-cascades/validation';\n");

await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vgpu', 'vgpu/node'],
  plugins: [{
    name: 'agent-radiance-wgsl',
    setup(builder) {
      builder.onLoad({ filter: /\.wgsl$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const result = await transformWgsl({ source, id: args.path });
        return { contents: result.code, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  }],
  logLevel: 'silent',
});

const { DEBUG_CAPTURES, renderDebugCaptures } = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);
let gpu;
try {
  gpu = await init();
  const output = target(gpu, { size: [width, height], format: 'rgba8unorm', label: 'agent-radiance-debug-output' });
  await renderDebugCaptures(gpu, output, async (capture, pixels) => {
    const outputPath = path.join(outDir, `${capture.name}.png`);
    await writePng(outputPath, pixels, width, height);
    console.log(`${capture.name}: t=${capture.time.toFixed(2)}s, view=${capture.view}`);
  }, quality);
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ width, height, quality, captures: DEBUG_CAPTURES }, null, 2)}\n`,
  );
  console.log(`Wrote ${DEBUG_CAPTURES.length} captures to ${outDir}`);
} finally {
  gpu?.dispose();
  await rm(cacheDir, { recursive: true, force: true });
}
