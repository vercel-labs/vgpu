import { expect, test } from "vitest";
import { createBindingLifetimeService } from "../src/binding-lifetime.ts";

/** A resource whose destroy callbacks the test fires, possibly more than once. */
function resource() {
  const callbacks = new Set<() => void>();
  return {
    subscribe: (callback: () => void) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    destroy: () => { for (const callback of [...callbacks]) callback(); },
  };
}

test("destroyEpoch counts first destructions and disposal, never registration, maintenance or invalidation", () => {
  const service = createBindingLifetimeService();
  const [first, second] = [resource(), resource()];
  const firstMarker = service.marker(first, "first", first.subscribe);
  service.marker(second, "second", second.subscribe);
  const dependent = { invalidateLifetime: () => undefined };
  const record = service.register(dependent, ["first", "second"]);
  service.maintain();
  service.invalidate("unrelated");
  service.unregister(record);
  service.register(dependent, ["second"]);
  expect(service.destroyEpoch).toBe(0);

  first.destroy();
  expect(firstMarker.destroyed).toBe(true);
  expect(service.destroyEpoch).toBe(1);
  first.destroy();
  expect(service.destroyEpoch).toBe(1);
  second.destroy();
  expect(service.destroyEpoch).toBe(2);

  service.dispose();
  expect(service.destroyEpoch).toBe(3);
  service.dispose();
  expect(service.destroyEpoch).toBe(3);
});

test("the epoch moves before dependents are invalidated, so they observe the destruction", () => {
  const service = createBindingLifetimeService();
  const tracked = resource();
  service.marker(tracked, "tracked", tracked.subscribe);
  const seen: number[] = [];
  service.register({ invalidateLifetime: () => { seen.push(service.destroyEpoch); } }, ["tracked"]);
  tracked.destroy();
  expect(seen).toEqual([1]);
});
