import { ShaderCodeScalesDemo } from "./shader-code-scales-demo";

export function ShaderCodeScalesSection() {
  return (
    <section
      aria-labelledby="shader-code-scales-heading"
      className="mb-36 pt-[4.5rem]"
    >
      <div className="mb-12 flex flex-col items-center text-center sm:mb-14">
        <h2
          className="text-pretty text-3xl font-normal leading-[1.05] tracking-[-0.045em] text-gray-1000 sm:text-5xl sm:leading-tight"
          id="shader-code-scales-heading"
        >
          Shader code that scales.
        </h2>
        <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-gray-900 md:text-lg">
          Import and export WGSL like TypeScript. vgpu resolves the module
          graph, reflects bindings, removes unused declarations, and emits
          compact shader source at build time.
        </p>
      </div>

      <div className="-mx-6 bg-background-200 px-6 py-10 lg:-mx-12 lg:px-12">
        <ShaderCodeScalesDemo />
      </div>
    </section>
  );
}
