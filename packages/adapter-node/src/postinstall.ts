import { installDawn } from "./dawn-installer.ts";

// Best effort only: package installation must remain usable offline and on
// platforms that rely on stock webgpu. Keep lifecycle latency tightly bounded;
// runtime resolution retries with the full download deadline and diagnostics.
try {
  await installDawn({ quiet: true, requestTimeoutMs: 500, overallTimeoutMs: 750 });
} catch {
  // Intentionally silent.
} finally {
  // A custom fetch implementation or response body may retain handles even
  // after abort. This dedicated lifecycle process must always finish cleanly.
  process.exit(0);
}
