import { fileURLToPath } from "node:url";

/** Private package asset; invokeTintWorker authenticates the bytes before execution. */
export function installedTintWorkerPath(): string {
  return fileURLToPath(
    new URL("./assets/darwin/vgpu-tint-worker", import.meta.url)
  );
}
