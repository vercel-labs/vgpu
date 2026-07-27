import { describe, expect, it, vi } from 'vitest';
import { createInferenceScheduler } from './inference-scheduler';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('single-flight inference scheduler', () => {
  it('never runs two inferences concurrently', async () => {
    const gates = [deferred(), deferred()];
    let inFlight = 0;
    let maxInFlight = 0;
    let index = 0;
    const scheduler = createInferenceScheduler<number>({
      onError: () => {},
      run: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gates[index++]!.promise;
        inFlight--;
      },
    });

    scheduler.request(1);
    scheduler.request(2);
    scheduler.request(3);
    expect(maxInFlight).toBe(1);
    expect(scheduler.pending).toBe(true);

    gates[0]!.resolve();
    await scheduler.active;
    await Promise.resolve();
    expect(maxInFlight).toBe(1);
    gates[1]!.resolve();
    await scheduler.active;
    expect(maxInFlight).toBe(1);
  });

  it('coalesces to the newest token and drops the intermediate ones', async () => {
    const gate = deferred();
    const seen: number[] = [];
    let first = true;
    const scheduler = createInferenceScheduler<number>({
      onError: () => {},
      run: async (token) => {
        seen.push(token);
        if (first) {
          first = false;
          await gate.promise;
        }
      },
    });

    scheduler.request(10);
    // 11 and 12 arrive while 10 is still running; only 12 survives.
    scheduler.request(11);
    scheduler.request(12);
    gate.resolve();
    await scheduler.active;
    await Promise.resolve();
    await scheduler.active;
    expect(seen).toEqual([10, 12]);
  });

  it('never re-runs when no new token arrives', async () => {
    const run = vi.fn(async () => {});
    const scheduler = createInferenceScheduler<number>({ onError: () => {}, run });
    scheduler.request(1);
    await scheduler.active;
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.active).toBeUndefined();
    expect(scheduler.pending).toBe(false);
    expect(scheduler.completed).toBe(1);
  });

  it('stop() refuses new work and hands back the in-flight run for draining', async () => {
    const gate = deferred();
    const run = vi.fn(async () => {
      await gate.promise;
    });
    const scheduler = createInferenceScheduler<number>({ onError: () => {}, run });
    scheduler.request(1);
    scheduler.request(2);

    const draining = scheduler.stop();
    expect(draining).toBeInstanceOf(Promise);
    expect(scheduler.stopped).toBe(true);

    gate.resolve();
    await draining;
    scheduler.request(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() before anything ran returns undefined', () => {
    const scheduler = createInferenceScheduler<number>({ onError: () => {}, run: async () => {} });
    expect(scheduler.stop()).toBeUndefined();
  });

  it('reports the first failure once and stops', async () => {
    const onError = vi.fn();
    const failure = new Error('session.run failed');
    const scheduler = createInferenceScheduler<number>({
      onError,
      run: () => Promise.reject(failure),
    });

    scheduler.request(1);
    await scheduler.active?.catch(() => undefined);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(scheduler.stopped).toBe(true);

    scheduler.request(2);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not count a failed run as completed', async () => {
    const scheduler = createInferenceScheduler<number>({
      onError: () => {},
      run: () => Promise.reject(new Error('nope')),
    });
    scheduler.request(1);
    await scheduler.active?.catch(() => undefined);
    expect(scheduler.completed).toBe(0);
  });
});
