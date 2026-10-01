import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { transformWgsl } from '@vgpu/wgsl/loader-vite';

const packedMetadataNamespace = 'docs-packed-wgsl';

/** @returns {import('esbuild').Plugin} */
export function docsWgslPlugin() {
  return {
    name: 'docs-wgsl',
    setup(build) {
      // transformWgsl emits absolute imports for its private metadata anchor. Keep the
      // query attached, but bypass esbuild's filesystem resolver and let the loader
      // validate and transform the complete generated request.
      build.onResolve({ filter: /\.wgsl\?__vgpu_packed_/ }, (args) => ({
        path: args.path,
        namespace: packedMetadataNamespace,
      }));
      build.onLoad({ filter: /.*/, namespace: packedMetadataNamespace }, async (args) => {
        const result = await transformWgsl({ source: '', id: args.path });
        return { contents: result.code, loader: 'js' };
      });
      build.onLoad({ filter: /\.wgsl$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const result = await transformWgsl({ source, id: args.path });
        return { contents: result.code, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}
