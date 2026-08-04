import { ExampleCard } from "@/components/example-card";
import { translations } from "@/geistdocs";
// TGEIST-09: `examplesMetadata` is the verbatim, unmodified data source
// ported by TGEIST-07 (`lib/examples-metadata.ts`) -- this page only decides
// how it is painted, not what is shown or in what order.
import { examplesMetadata } from "@/lib/examples-metadata";

const title = "Examples";
const description =
  "Fullscreen shaders, compute pipelines, raw WebGPU interop, and read-only source files compiled directly by this docs app.";

export const metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const ExamplesPage = () => (
  <main className="mx-auto max-w-[1200px] px-4 pb-32 sm:px-6">
    <header className="pt-12 pb-8 sm:pt-16 sm:pb-10">
      <h1 className="font-medium! text-heading-32 text-gray-1000 tracking-tighter sm:text-heading-40">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-copy-16 text-gray-900">{description}</p>
    </header>

    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {examplesMetadata.map((example) => (
        <ExampleCard example={example} key={example.slug} />
      ))}
    </div>
  </main>
);

export default ExamplesPage;
