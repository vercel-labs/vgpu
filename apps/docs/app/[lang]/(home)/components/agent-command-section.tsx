import { AgentCommandDemo } from "./agent-command-demo";

export function AgentCommandSection() {
  return (
    <section aria-labelledby="agent-command-heading" className="mb-36">
      <div className="mb-12 flex flex-col items-center text-center sm:mb-14">
        <h2
          className="text-pretty text-3xl font-normal leading-[1.05] tracking-[-0.045em] text-gray-1000 sm:text-5xl sm:leading-tight"
          id="agent-command-heading"
        >
          The CLI guides your agent.
        </h2>
        <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-gray-900 md:text-lg">
          The docs, examples, validation tools, and runtime
          diagnostics are accesible from the CLI. Everything starts with <code className="rounded-md bg-gray-200 px-2 py-1 font-mono text-[12px] text-gray-900">npx vgpu</code>
        </p>
      </div>

      <div className="-mx-6 bg-background-200 px-6 py-10 lg:-mx-12 lg:px-12">
        <AgentCommandDemo />
      </div>
    </section>
  );
}
