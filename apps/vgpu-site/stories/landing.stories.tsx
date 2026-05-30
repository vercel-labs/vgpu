import type { Meta, StoryObj } from "@storybook/react";
import {
  ComparisonSection,
  DocsCtaSection,
  EscapeHatchSection,
  FeaturePillarsSection,
  Footer,
  Header,
  HeroSection,
  LandingPage,
  WorkflowSection,
} from "../components/landing";

const meta = {
  title: "VGPU Site/Landing",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = {
  render: () => <LandingPage />,
};

export const Hero: Story = {
  render: () => <HeroSection />,
};

export const Comparison: Story = {
  render: () => <ComparisonSection />,
};

export const FeaturePillars: Story = {
  render: () => <FeaturePillarsSection />,
};

export const Workflow: Story = {
  render: () => <WorkflowSection />,
};

export const EscapeHatch: Story = {
  render: () => <EscapeHatchSection />,
};

export const DocsCta: Story = {
  render: () => <DocsCtaSection />,
};

export const NavigationAndFooter: Story = {
  render: () => (
    <>
      <Header />
      <Footer />
    </>
  ),
};
