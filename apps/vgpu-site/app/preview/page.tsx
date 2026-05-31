import {
  ComparisonSection,
  FeaturePillarsSection,
  Header,
  HeroSection,
  WorkflowSection,
} from "@/components/landing";

export default function PreviewPage() {
  return (
    <>
      <Header />
      <main>
        <section className="border-y border-border px-5 py-12 md:px-8">
          <div className="mx-auto max-w-7xl">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">Component preview</p>
            <h1 className="mt-4 text-balance text-5xl font-semibold tracking-[-0.05em]">VGPU site sections</h1>
            <p className="mt-4 max-w-2xl text-pretty text-base text-muted-foreground">App-local preview route for agents when Storybook is not running.</p>
          </div>
        </section>
        <HeroSection />
        <ComparisonSection />
        <FeaturePillarsSection />
        <WorkflowSection />
      </main>
    </>
  );
}
