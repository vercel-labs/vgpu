import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "vgpu hero",
  description: "Landing page hero.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
