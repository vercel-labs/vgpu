import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://github.com/vercel-labs/vgpu'),
  title: {
    default: 'vgpu Docs',
    template: '%s | vgpu',
  },
  description: 'Agentic-first WebGPU primitives for Node, browsers, and serverless runtimes.',
  openGraph: {
    title: 'vgpu Docs',
    description: 'Small, composable WebGPU primitives for rendering, WGSL tooling, and adapters.',
    url: 'https://github.com/vercel-labs/vgpu',
    siteName: 'vgpu',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'vgpu Docs',
    description: 'Small, composable WebGPU primitives for rendering, WGSL tooling, and adapters.',
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const DevInstrumentation =
    process.env.NODE_ENV === 'development'
      ? (await import('@/components/dev-instrumentation')).DevInstrumentation
      : null;

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="bg-black text-gray-12 font-sans antialiased">
        {children}
        {DevInstrumentation ? <DevInstrumentation /> : null}
      </body>
    </html>
  );
}
