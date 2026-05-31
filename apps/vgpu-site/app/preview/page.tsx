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
        <section className="border-y border-border px-tab-5 py-tab-8 md:px-tab-8">
          <div className="mx-auto max-w-7xl">
            <p className="text-[0.75rem] uppercase tracking-[0.24em] text-muted-foreground">Component preview</p>
            <h1 className="mt-tab-3 text-balance text-[2.75rem] font-semibold tracking-[-0.05em]">VGPU site sections</h1>
            <p className="mt-tab-3 max-w-2xl text-pretty text-muted-foreground">App-local preview route for agents when Storybook is not running.</p>
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
