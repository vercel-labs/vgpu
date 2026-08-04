import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@vercel/geistdocs/components/card';

// Same copy as the old landing (apps/docs/app/page.tsx:pillars) — only the
// card chrome is rebuilt with the geistdocs template's Card primitives.
const pillars = [
  {
    title: 'WGSL modules',
    description:
      'Import and export WGSL like TypeScript. Compose shaders from modules, not string templates.',
    code: 'import { noise } from "./noise.wgsl"',
  },
  {
    title: 'Ready for agents',
    description:
      'Docs, CLI and skill built for coding agents. Your agent gets the full API in one command.',
    code: 'npx vgpu',
  },
  {
    title: 'Runs on web and Node.js',
    description:
      'One API everywhere. Render to canvas in the browser, test and screenshot headlessly in Node.',
    code: 'import { init } from "vgpu/node"',
  },
];

export function PillarsSection() {
  return (
    <section className="mb-24">
      <h2 className="mb-10 text-2xl text-gray-12 md:text-3xl">Why vgpu</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {pillars.map((pillar) => (
          <Card key={pillar.title} className="overflow-hidden rounded-lg py-0">
            <CardHeader className="border-b px-5 py-4">
              <CardTitle className="text-sm font-normal text-gray-12">{pillar.title}</CardTitle>
            </CardHeader>
            <CardContent className="p-5">
              <p className="text-sm leading-relaxed text-gray-9">{pillar.description}</p>
              <div className="mt-5 whitespace-normal break-words rounded-md border border-gray-4 bg-black px-3 py-2 font-mono text-sm text-gray-10">
                {pillar.code}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
