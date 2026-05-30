import { GeistMono, GeistSans } from "geist/font";
import { GeistPixelSquare } from "geist/font/pixel";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "VGPU — WebGPU primitives for products and agents",
  description:
    "A standalone landing page for VGPU: typed WebGPU helpers, headless snapshots, and a native escape hatch.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#050505",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable}`}>
      <body>{children}</body>
    </html>
  );
}
