import { expect, test } from "@playwright/test";
import path from "node:path";

const artifactRoot = path.join(process.cwd(), "artifacts", "vgpu-site");

test("writes stable landing page PNG artifact", async ({ page }, testInfo) => {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        scroll-behavior: auto !important;
      }
    `,
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: /Ship GPU interfaces/i })).toBeVisible();
  await expect(page.getByText("Native WebGPU vs VGPU")).toBeVisible();

  const fileName = testInfo.project.name === "mobile" ? "landing-mobile.png" : "landing-desktop.png";
  await page.screenshot({
    path: path.join(artifactRoot, fileName),
    fullPage: true,
    animations: "disabled",
  });
});
