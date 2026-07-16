import createMDX from '@next/mdx';
import { docsManifest } from '@vgpu/cli/lib/generated/docs-manifest.generated.js';

const withMDX = createMDX({
  extension: /\.mdx?$/,
});

function referencePackageName(record) {
  if (record.package === 'vgpu' || record.package === 'vgpu/core' || record.package === 'vgpu/scene') return record.package;
  if (record.package.startsWith('@vgpu/wgsl-std')) return '@vgpu/wgsl-std';
  if (record.package.startsWith('@vgpu/wgsl')) return '@vgpu/wgsl';
  if (record.package.startsWith('@vgpu/render')) return '@vgpu/render';
  return record.package;
}

function slugifyPackage(packageName) {
  if (packageName === '@vgpu/wgsl') return 'wgsl';
  if (packageName === '@vgpu/wgsl-std') return 'wgsl-std';
  if (packageName === '@vgpu/render') return 'render';
  return packageName.replace(/^@/, '').replace(/[\/@]/g, '-');
}

function legacyPackageSlug(packageName) {
  return packageName.replace(/^@/, '').replace(/[\/@]/g, '-');
}

const packageRedirects = Array.from(new Set(
  docsManifest.records
    .filter((record) => record.kind === 'api')
    .map((record) => record.package),
)).map((packageName) => ({
  source: `/packages/${legacyPackageSlug(packageName)}`,
  destination: `/reference#${slugifyPackage(referencePackageName({ package: packageName }))}`,
  permanent: true,
}));

const symbolRedirects = docsManifest.records
  .filter((record) => record.kind === 'api')
  .map((record) => ({
    source: `/packages/${legacyPackageSlug(record.package)}/${encodeURIComponent(record.symbol)}`,
    destination: `/reference/${slugifyPackage(referencePackageName(record))}/${encodeURIComponent(record.topic)}#${record.anchor}`,
    permanent: true,
  }));

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],
  reactStrictMode: true,
  async redirects() {
    return [
      { source: '/api', destination: '/reference', permanent: true },
      { source: '/packages', destination: '/reference', permanent: true },
      { source: '/packages/vgpu/Pass', destination: '/reference/vgpu/effect#effect', permanent: true },
      { source: '/packages/vgpu/PassOptions', destination: '/reference/vgpu/effect#effectoptions', permanent: true },
      { source: '/reference/vgpu/pass', destination: '/reference/vgpu/effect', permanent: true },
      ...packageRedirects,
      ...symbolRedirects,
    ];
  },
  transpilePackages: [
    'vgpu',
    '@vgpu/core',
    '@vgpu/wgsl',
    '@vgpu/wgsl-std',
    '@vgpu/adapter-mock',
    '@vgpu/adapter-node',
  ],
  turbopack: {
    rules: {
      '*.wgsl': {
        loaders: ['@vgpu/wgsl/loader-webpack'],
        as: '*.js',
      },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.wgsl$/,
      use: '@vgpu/wgsl/loader-webpack',
    });
    return config;
  },
};

export default withMDX(nextConfig);
