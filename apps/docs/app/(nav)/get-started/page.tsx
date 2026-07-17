import Link from 'next/link';

export const metadata = {
  title: 'Get started',
  description: 'vgpu runs in the browser and in Node.js with the same API. Pick your platform, then learn the core ideas.',
};

const platforms = [
  {
    title: 'Web',
    href: '/get-started/web',
    description: 'Render to a canvas with WebGPU, and set up the .wgsl loader for Next.js or Vite.',
  },
  {
    title: 'Node.js',
    href: '/get-started/node',
    description: 'Render headless through Dawn — save a PNG or assert on pixels in a test.',
  },
];

export default function GetStartedPage() {
  return (
    <article className="px-4 py-8 lg:px-8 lg:py-12 max-w-6xl mx-auto">
      <h1 className="text-3xl font-semibold text-gray-12">Get started</h1>
      <p className="mt-4 max-w-2xl leading-7 text-gray-11">
        vgpu runs in two places with the same API: the browser, where WebGPU renders straight to a canvas,
        and Node.js, where Dawn renders headless for scripts, servers, and tests.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {platforms.map((platform) => (
          <Link
            key={platform.href}
            href={platform.href}
            className="rounded-lg border border-gray-4 bg-gray-1 p-6 transition-colors hover:border-gray-5 hover:bg-gray-2"
          >
            <h2 className="text-lg font-semibold text-gray-12">{platform.title}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-10">{platform.description}</p>
          </Link>
        ))}
      </div>

      <h2 className="mt-12 text-xl font-semibold text-gray-12">Next: the concepts</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-10">
        Once you can render on your platform, learn the ideas every vgpu program is built from.
      </p>

      <Link
        href="/concepts"
        className="mt-6 block rounded-lg border border-gray-4 bg-gray-1 p-4 transition-colors hover:border-gray-5 hover:bg-gray-2"
      >
        <span className="font-medium text-gray-12">Concepts</span>
        <span className="ml-3 text-sm text-gray-10">Context, effects, passes, frames, and render bundles — in reading order.</span>
      </Link>
    </article>
  );
}
