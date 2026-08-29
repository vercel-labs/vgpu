export function runAll(actions: readonly (() => unknown)[]): void {
  let firstError: unknown;
  let failed = false;
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

export function quietly(action: () => unknown): void {
  try {
    action();
  } catch {
    // Keep the operation's primary failure.
  }
}
