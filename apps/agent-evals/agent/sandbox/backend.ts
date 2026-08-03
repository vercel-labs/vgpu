import type { SandboxBackend } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { vercel } from "eve/sandbox/vercel";

/**
 * Pinned by tag rather than left floating.
 *
 * `docker()` defaults to `ghcr.io/vercel/eve:latest` with an if-not-present
 * pull policy, which means two machines can silently run two different base
 * images — and the difference shows up as "the model got worse", not as an
 * infra change. Bump this deliberately.
 */
const DOCKER_IMAGE = process.env.VGPU_EVALS_DOCKER_IMAGE || "ghcr.io/vercel/eve:latest";

/**
 * The ONLY place in this package allowed to construct a sandbox backend.
 *
 * Rules:
 * 1. No other file may import `eve/sandbox/docker`, `eve/sandbox/vercel` or
 *    `eve/sandbox/microsandbox`.
 * 2. Nothing may use `defaultBackend()`. Its fallback cascade can degrade to
 *    `just-bash`, which has no real binaries — that turns an infra problem into
 *    a fake "the agent failed" result.
 * 3. An unknown `VGPU_EVALS_SANDBOX` value throws at startup. Never fall back
 *    silently.
 */
export function evalSandboxBackend(): SandboxBackend {
  const kind = sandboxKind();

  if (kind === "vercel") {
    // No `runtime` here, and that is not an omission: eve always boots its
    // sandboxes from the published eve image, so `runtime` is excluded from the
    // options type. The consequence matters for the renderer — a Vercel run
    // does NOT land on the AL2023 stock runtime the vgpu sandbox spike used, so
    // that spike's `dnf install mesa-vulkan-drivers` is not the remedy here;
    // the eve image is Debian-based and takes vgpu's portable software
    // renderer instead (see prescriptionsFor in sandbox.ts).
    //
    // x86_64 only: vgpu's Dawn/lavapipe path was verified there, not on arm64.
    return vercel({ resources: { vcpus: 2 }, timeout: 10 * 60 * 1000 });
  }

  return docker({ image: DOCKER_IMAGE });
}

/** Single source of truth for the selector, so bootstrap can branch on it too. */
export function sandboxKind(): "docker" | "vercel" {
  const kind = process.env.VGPU_EVALS_SANDBOX || "docker";
  if (kind !== "docker" && kind !== "vercel") {
    throw new Error(`VGPU_EVALS_SANDBOX invalid: ${kind} (expected "docker" or "vercel")`);
  }
  return kind;
}
