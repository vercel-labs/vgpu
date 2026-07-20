import { installDawn } from "./dawn-installer.ts";

// Best effort only: package installation must remain usable offline and on platforms
// that currently rely on the stock webgpu package.
try {
  await installDawn({ quiet: true });
} catch {
  // Lazy resolution retries at runtime and provides the actionable structured error.
}
