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

const coreIdeas = [
  { title: 'Context', href: '/get-started/context', description: 'init() creates the Gpu context everything else comes from.' },
  { title: 'Effects', href: '/get-started/effects', description: 'Full-screen fragment shaders you can chain through targets.' },
  { title: 'Passes', href: '/get-started/passes', description: 'Each pass renders into one target inside a frame.' },
  { title: 'Frames', href: '/get-started/frames', description: 'Encode one frame and submit once, or loop for animation.' },
  { title: 'Render bundles', href: '/get-started/render-bundles', description: 'Record passes once and replay them to save CPU.' },
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

      <h2 className="mt-12 text-xl font-semibold text-gray-12">Core ideas</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-10">
        Five ideas cover every vgpu program. Read them in order — each page builds on the previous one.
      </p>

      <div className="mt-6 grid gap-3">
        {coreIdeas.map((idea) => (
          <Link
            key={idea.href}
            href={idea.href}
            className="flex flex-col gap-1 rounded-lg border border-gray-4 bg-gray-1 p-4 transition-colors hover:border-gray-5 hover:bg-gray-2 sm:flex-row sm:items-baseline sm:gap-3"
          >
            <span className="font-medium text-gray-12">{idea.title}</span>
            <span className="text-sm text-gray-10">{idea.description}</span>
          </Link>
        ))}
      </div>
    </article>
  );
}
