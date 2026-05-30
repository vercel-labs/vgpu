import {
  ComparisonSection,
  DocsCtaSection,
  EscapeHatchSection,
  FeaturePillarsSection,
  Footer,
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
            <p className="text-tab-3 uppercase tracking-[0.24em] text-muted-foreground">Component preview</p>
            <h1 className="mt-tab-3 text-[44px] font-semibold tracking-[-0.05em]">VGPU site sections</h1>
            <p className="mt-tab-3 max-w-2xl text-muted-foreground">App-local preview route for agents when Storybook is not running.</p>
          </div>
        </section>
        <HeroSection />
        <ComparisonSection />
        <FeaturePillarsSection />
        <WorkflowSection />
        <EscapeHatchSection />
        <DocsCtaSection />
      </main>
      <Footer />
    </>
  );
}
