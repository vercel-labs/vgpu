import type { Preview } from "@storybook/react";
import "../app/globals.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "VGPU dark",
      values: [{ name: "VGPU dark", value: "#050505" }],
    },
    layout: "fullscreen",
  },
};

export default preview;
