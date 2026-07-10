import createMDX from '@next/mdx';

const withMDX = createMDX({
  extension: /\.mdx?$/,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],
  reactStrictMode: true,
  transpilePackages: [
    'vgpu',
    '@vgpu/core',
    '@vgpu/render',
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
