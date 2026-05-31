import { AgentationToolbar } from "@/components/agentation-toolbar";
import { DesignTuner } from "@/components/design-tuner";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "vgpu - webgpu for agents",
  description:
    "VGPU is a WebGPU framework for agents: typed helpers, runnable docs, and visual artifacts.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#050505",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const devToolsEnabled = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_AGENTATION_ENABLED === "1";

  return (
    <html lang="en">
      <body>
        {children}
        <AgentationToolbar />
        <DesignTuner enabled={devToolsEnabled} />
      </body>
    </html>
  );
}
