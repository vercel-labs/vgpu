import { expect, test, vi } from 'vitest';

import type { QualityTier } from './quality';
import { createQualityController, type TierResources } from './quality-controller';

interface FakeTier extends TierResources {
  readonly tier: QualityTier;
  readonly destroy: ReturnType<typeof vi.fn>;
  resolvePrepare(): void;
  rejectPrepare(error: Error): void;
}

function fakeTiers() {
  const created: FakeTier[] = [];
  const createTier = vi.fn((tier: QualityTier): FakeTier => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const prepared = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const resources: FakeTier = {
      tier,
      prepare: () => prepared,
      destroy: vi.fn(),
      resolvePrepare: resolve,
      rejectPrepare: reject,
    };
    created.push(resources);
    return resources;
  });
  return { created, createTier };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test('auto starts High and reports the initial state once ready', async () => {
  const { created, createTier } = fakeTiers();
  const onActivate = vi.fn();
  const controller = createQualityController({ createTier, onActivate });
  expect(controller.state).toEqual({ preference: 'auto', effective: 'high', reason: 'initial' });
  expect(controller.active).toBeUndefined();
  created[0]!.resolvePrepare();
  await controller.ready;
  expect(onActivate).toHaveBeenCalledWith('high', created[0]);
  expect(controller.active).toBe(created[0]);
  expect(controller.state).toEqual({ preference: 'auto', effective: 'high', reason: 'initial' });
});

test('downgrade prepares Low off-screen, then swaps and destroys High', async () => {
  const { created, createTier } = fakeTiers();
  const listener = vi.fn();
  const controller = createQualityController({ createTier });
  controller.subscribe(listener);
  created[0]!.resolvePrepare();
  await controller.ready;

  const downgrade = controller.downgrade('battery');
  await settle();
  expect(createTier).toHaveBeenCalledWith('low');
  // High keeps rendering while Low prepares.
  expect(controller.active).toBe(created[0]);
  expect(created[0]!.destroy).not.toHaveBeenCalled();

  created[1]!.resolvePrepare();
  await downgrade;
  expect(controller.active).toBe(created[1]);
  expect(created[0]!.destroy).toHaveBeenCalledOnce();
  expect(controller.state).toEqual({ preference: 'auto', effective: 'low', reason: 'battery' });
  expect(listener).toHaveBeenLastCalledWith({ preference: 'auto', effective: 'low', reason: 'battery' });
});

test('downgrade is one-way and ignored outside auto/High', async () => {
  const { created, createTier } = fakeTiers();
  const controller = createQualityController({ createTier });
  created[0]!.resolvePrepare();
  await controller.ready;
  const first = controller.downgrade('gpu-tier');
  await settle();
  created[1]!.resolvePrepare();
  await first;
  await controller.downgrade('frame-health');
  expect(createTier).toHaveBeenCalledTimes(2);
  expect(controller.state.reason).toBe('gpu-tier');

  const forced = createQualityController({ createTier: fakeTiers().createTier, initialPreference: 'high' });
  await forced.downgrade('battery');
  expect(forced.state).toEqual({ preference: 'high', effective: 'high', reason: 'forced' });
});

test('a stale candidate is discarded when the request changes mid-prepare', async () => {
  const { created, createTier } = fakeTiers();
  const controller = createQualityController({ createTier });
  created[0]!.resolvePrepare();
  await controller.ready;

  const toLow = controller.setPreference('low');
  await settle();
  expect(created[1]!.tier).toBe('low');
  const backToHigh = controller.setPreference('high');
  created[1]!.resolvePrepare();
  await toLow;
  await backToHigh;
  // The Low candidate was destroyed without ever becoming active; High stayed on screen.
  expect(created[1]!.destroy).toHaveBeenCalledOnce();
  expect(controller.active).toBe(created[0]);
  expect(controller.state).toEqual({ preference: 'high', effective: 'high', reason: 'forced' });
});

test('a failed prepare reverts the request and rejects the caller', async () => {
  const { created, createTier } = fakeTiers();
  const controller = createQualityController({ createTier });
  created[0]!.resolvePrepare();
  await controller.ready;
  const pending = controller.setPreference('low');
  await settle();
  const error = new Error('no memory');
  created[1]!.rejectPrepare(error);
  await expect(pending).rejects.toBe(error);
  expect(created[1]!.destroy).toHaveBeenCalledOnce();
  expect(controller.active).toBe(created[0]);
  expect(controller.state.effective).toBe('high');
});

test('switching back to auto from a forced Low returns to High and re-arms', async () => {
  const { created, createTier } = fakeTiers();
  const controller = createQualityController({ createTier, initialPreference: 'low' });
  created[0]!.resolvePrepare();
  await controller.ready;
  expect(controller.state).toEqual({ preference: 'low', effective: 'low', reason: 'forced' });
  const toAuto = controller.setPreference('auto');
  await settle();
  created[1]!.resolvePrepare();
  await toAuto;
  expect(controller.state).toEqual({ preference: 'auto', effective: 'high', reason: 'initial' });
  const downgrade = controller.downgrade('frame-health');
  await settle();
  created[2]!.resolvePrepare();
  await downgrade;
  expect(controller.state).toEqual({ preference: 'auto', effective: 'low', reason: 'frame-health' });
});

test('destroy releases the active tier and drops late candidates', async () => {
  const { created, createTier } = fakeTiers();
  const controller = createQualityController({ createTier });
  created[0]!.resolvePrepare();
  await controller.ready;
  const pending = controller.downgrade('battery');
  await settle();
  controller.destroy();
  expect(created[0]!.destroy).toHaveBeenCalledOnce();
  created[1]!.resolvePrepare();
  await pending;
  expect(created[1]!.destroy).toHaveBeenCalledOnce();
  expect(controller.active).toBeUndefined();
});
