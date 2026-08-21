import { ImageResponse } from "next/og";

export const alt = "vgpu — the WebGPU library designed for agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#0a0a0a",
        color: "#ededed",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        letterSpacing: "-0.04em",
        width: "100%",
      }}
    >
      <div style={{ fontSize: 124, fontWeight: 650 }}>vgpu</div>
      <div style={{ color: "#a1a1a1", fontSize: 42, letterSpacing: "-0.025em", marginTop: 22 }}>
        The WebGPU library, designed for agents.
      </div>
    </div>,
    size,
  );
}
