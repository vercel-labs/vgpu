import type { TierResult } from '@pmndrs/detect-gpu';
import { expect, test, vi } from 'vitest';

import { batteryRequestsLow, createQualitySignals, gpuTierRequestsLow } from './quality-signals';

const tier = (type: TierResult['type'], value: number, isMobile = false): TierResult => ({
  type,
  tier: value,
  isMobile,
});
const silentLogger = () => ({ info: vi.fn() });
const neverResolves = () => new Promise<TierResult>(() => {});

test.each([
  ['BENCHMARK', 0, true],
  ['BENCHMARK', 1, true],
  ['BENCHMARK', 2, false],
  ['BENCHMARK', 3, false],
  ['BLOCKLISTED', 0, true],
  ['FALLBACK', 1, false],
  ['BENCHMARK_FETCH_FAILED', 1, false],
  ['WEBGL_UNSUPPORTED', 0, false],
  ['SSR', 0, false],
] as const)('maps %s tier %d to downgrade=%s', (type, value, expected) => {
  expect(gpuTierRequestsLow(tier(type, value))).toBe(expected);
});

test('mobile devices request Low regardless of tier', () => {
  expect(gpuTierRequestsLow(tier('BENCHMARK', 3, true))).toBe(true);
  expect(gpuTierRequestsLow(tier('FALLBACK', 1, true))).toBe(true);
});

test.each([
  [{ charging: false, level: 0.3 }, true],
  [{ charging: false, level: 0.29 }, true],
  [{ charging: false, level: 0.31 }, false],
  [{ charging: true, level: 0.05 }, false],
  [{ charging: false, level: Number.NaN }, false],
  [undefined, false],
] as const)('battery %j requests Low=%s', (battery, expected) => {
  expect(batteryRequestsLow(battery)).toBe(expected);
});

test('a low benchmark tier downgrades once with reason gpu-tier', async () => {
  const onDowngrade = vi.fn();
  const logger = silentLogger();
  const signals = createQualitySignals({
    navigator: {},
    loadGpuTier: async () => tier('BENCHMARK', 1),
    logger,
    onDowngrade,
  });
  await vi.waitFor(() => expect(onDowngrade).toHaveBeenCalledWith('gpu-tier'));
  expect(logger.info).toHaveBeenCalledWith(
    '[quality] GPU detected.',
    expect.objectContaining({ type: 'BENCHMARK', tier: 1, decision: 'request-low' }),
  );
  signals.recordFrame({ deltaMs: 500, active: true, rendered: false });
  expect(onDowngrade).toHaveBeenCalledTimes(1);
  signals.dispose();
});

test('GPU detection failures are advisory and keep High', async () => {
  const onDowngrade = vi.fn();
  const logger = silentLogger();
  const signals = createQualitySignals({
    navigator: {},
    loadGpuTier: () => Promise.reject(new Error('blocked')),
    logger,
    onDowngrade,
  });
  await vi.waitFor(() =>
    expect(logger.info).toHaveBeenCalledWith(
      '[quality] GPU detection unavailable.',
      expect.objectContaining({ error: 'blocked', decision: 'keep-high' }),
    ),
  );
  expect(onDowngrade).not.toHaveBeenCalled();
  signals.dispose();
});

test('a discharging battery at or below 30% downgrades, later changes are observed', async () => {
  const onDowngrade = vi.fn();
  const listeners = new Map<string, EventListener>();
  const battery = {
    charging: false,
    level: 0.8,
    addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    dispatchEvent: vi.fn(),
  };
  const signals = createQualitySignals({
    navigator: { getBattery: async () => battery },
    loadGpuTier: neverResolves,
    logger: silentLogger(),
    onDowngrade,
  });
  await vi.waitFor(() => expect(battery.addEventListener).toHaveBeenCalledWith('levelchange', expect.any(Function)));
  expect(onDowngrade).not.toHaveBeenCalled();
  battery.level = 0.25;
  listeners.get('levelchange')!(new Event('levelchange'));
  expect(onDowngrade).toHaveBeenCalledWith('battery');
  signals.dispose();
  expect(battery.removeEventListener).toHaveBeenCalledWith('levelchange', expect.any(Function));
});

test('frame health drives a frame-health downgrade through the injected monitor', () => {
  const onDowngrade = vi.fn();
  const record = vi
    .fn()
    .mockReturnValueOnce({ downgrade: false, estimatedRefreshFps: 60, targetFps: 60, thresholdFps: 48, activeWindowMs: 500 })
    .mockReturnValueOnce({ downgrade: true, estimatedRefreshFps: 60, targetFps: 60, thresholdFps: 48, observedFps: 20, activeWindowMs: 2_000 });
  const signals = createQualitySignals({
    navigator: {},
    loadGpuTier: neverResolves,
    healthMonitor: { record, reset: vi.fn() },
    logger: silentLogger(),
    onDowngrade,
  });
  const sample = { deltaMs: 1_000 / 60, active: true, rendered: true };
  signals.recordFrame(sample);
  expect(onDowngrade).not.toHaveBeenCalled();
  signals.recordFrame(sample);
  expect(onDowngrade).toHaveBeenCalledWith('frame-health');
  signals.recordFrame(sample);
  expect(record).toHaveBeenCalledTimes(2);
  signals.dispose();
});

test('a disposed controller never fires', async () => {
  const onDowngrade = vi.fn();
  let resolveTier!: (value: TierResult) => void;
  const pending = new Promise<TierResult>((resolve) => { resolveTier = resolve; });
  const signals = createQualitySignals({
    navigator: {},
    loadGpuTier: () => pending,
    logger: silentLogger(),
    onDowngrade,
  });
  signals.dispose();
  resolveTier(tier('BLOCKLISTED', 0));
  await pending;
  await Promise.resolve();
  await Promise.resolve();
  expect(onDowngrade).not.toHaveBeenCalled();
});
