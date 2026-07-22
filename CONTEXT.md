# Glossary

- **Probe** — one read-only environment check run by `vgpu doctor` (e.g. "Vulkan ICD present").
- **Finding** — the result of a probe: a status (`ok`/`warn`/`fail`/`skip`), the evidence observed, and — when actionable — a prescription.
- **Prescription** — the exact command or environment change that resolves a failing finding, chosen so an agent can always execute it (package install command per distro, env export).
- **Verdict** — the bottom line of a doctor run: whether this machine acquired an adapter and rendered headless (`healthy`), failed to (`unhealthy`), or skipped the render (`unverified`).
- **Healthy** — the machine can acquire a WebGPU adapter and render headless with `vgpu/node`, by any adapter (hardware or software).
