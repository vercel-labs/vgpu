/** Waits for every GPU-owning task, then rethrows the first observed failure. */
export async function settleAllOrThrow(
  work: readonly PromiseLike<unknown>[]
): Promise<void> {
  let firstFailure: unknown;
  let failed = false;
  const tracked = work.map((task) =>
    Promise.resolve(task).catch((error: unknown) => {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
      throw error;
    })
  );
  await Promise.allSettled(tracked);
  if (failed) throw firstFailure;
}
