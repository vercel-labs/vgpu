import { AgentationToolbar } from "@/components/agentation-toolbar";
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
  return (
    <html lang="en">
      <body>
        {children}
        <AgentationToolbar />
      </body>
    </html>
  );
}
