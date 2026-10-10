import { expect, test, vi } from "vitest";
import { CAPTURE_PAGE_KIND, bindGroupCacheTestState, bindGroupClock, bindGroupKeyOf, createBindGroupCache } from "../src/bind-cache.ts";

const layout = (name: string): GPUBindGroupLayout => ({ label: name }) as GPUBindGroupLayout;
const group = (name: string): GPUBindGroup => ({ label: name }) as GPUBindGroup;

test("owner cache reuses A to B to A while isolating owners, layouts, and binding slots", () => {
  const cache = createBindGroupCache();
  const firstOwner = {};
  const secondOwner = {};
  const firstLayout = layout("first");
  const secondLayout = layout("second");
  const create = vi.fn((name: string) => group(name));

  const firstA = cache.getOrCreate(firstOwner, 0, firstLayout, [{ binding: 0, key: "A" }], ["A"], () => create("first-A"));
  const firstB = cache.getOrCreate(firstOwner, 0, firstLayout, [{ binding: 0, key: "B" }], ["B"], () => create("first-B"));

  expect(cache.getOrCreate(firstOwner, 0, firstLayout, [{ binding: 0, key: "A" }], ["A"], () => create("unexpected"))).toBe(firstA);
  expect(firstB).not.toBe(firstA);
  expect(cache.getOrCreate(secondOwner, 0, firstLayout, [{ binding: 0, key: "A" }], ["A"], () => create("second-owner"))).not.toBe(firstA);
  expect(cache.getOrCreate(firstOwner, 0, secondLayout, [{ binding: 0, key: "A" }], ["A"], () => create("second-layout"))).not.toBe(firstA);
  expect(cache.getOrCreate(firstOwner, 0, firstLayout, [{ binding: 1, key: "A" }], ["A"], () => create("second-slot"))).not.toBe(firstA);
  expect(cache.getOrCreate(firstOwner, 1, firstLayout, [{ binding: 0, key: "A" }], ["A"], () => create("second-group"))).not.toBe(firstA);
  const ordered = cache.getOrCreate(firstOwner, 2, firstLayout, [{ binding: 1, key: "B" }, { binding: 0, key: "A" }], ["A", "B"], () => create("ordered"));
  expect(cache.getOrCreate(firstOwner, 2, firstLayout, [{ binding: 0, key: "A" }, { binding: 1, key: "B" }], ["A", "B"], () => create("unexpected"))).toBe(ordered);
  const secondCache = createBindGroupCache();
  expect(secondCache.getOrCreate(firstOwner, 0, firstLayout, [{ binding: 0, key: "A" }], ["A"], () => create("second-device"))).not.toBe(firstA);
  expect(create).toHaveBeenCalledTimes(8);
});

test("frame capture release evicts only entries using that exact slice", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const bgl = layout("captures");
  const first = cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "slice:first" }], ["resource", "slice:first"], () => group("first"));
  const second = cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "slice:second" }], ["resource", "slice:second"], () => group("second"));

  cache.evictIdentity("slice:first");
  expect(state.ownerEntries(owner)).toBe(1);
  expect(cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "slice:second" }], ["resource", "slice:second"], () => group("unexpected"))).toBe(second);
  expect(cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "slice:first" }], ["resource", "slice:first"], () => group("first-recreated"))).not.toBe(first);
});

test("the 65th variant evicts the least recently used entry and unlinks its metadata", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const bgl = layout("bounded");
  const groups = Array.from({ length: 65 }, (_, index) =>
    cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: index }], [index], () => group(String(index))),
  );

  expect(state.ownerEntries(owner)).toBe(64);
  expect(state.lifetime.records).toBe(64);
  expect(cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: 0 }], [0], () => group("replacement"))).not.toBe(groups[0]);
  expect(state.ownerEntries(owner)).toBe(64);
});

test("a hit refreshes LRU recency and an old dependency record cannot delete its replacement", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const bgl = layout("lru");
  const first = cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "A" }], ["old-A"], () => group("A"));
  let one: GPUBindGroup | undefined;
  for (let index = 1; index < 64; index += 1) {
    const created = cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: index }], [index], () => group(String(index)));
    if (index === 1) one = created;
  }
  expect(cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "A" }], ["old-A"], () => group("unexpected"))).toBe(first);
  cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: 64 }], [64], () => group("64"));
  expect(cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: 1 }], [1], () => group("replacement-1"))).not.toBe(one);

  cache.evictIdentity("old-A");
  const replacement = cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "A" }], ["new-A"], () => group("new-A"));
  cache.evictIdentity("old-A");
  expect(cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: "A" }], ["new-A"], () => group("unexpected"))).toBe(replacement);
  expect(state.ownerEntries(owner)).toBe(64);
});

test("targeted eviction and clearOwner do not traverse or remove unrelated owners", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const first = {};
  const second = {};
  const bgl = layout("shared");
  cache.getOrCreate(first, 0, bgl, [{ binding: 0, key: "first" }], ["first-resource", "frame:first"], () => group("first"));
  cache.getOrCreate(second, 0, bgl, [{ binding: 0, key: "second" }], ["second-resource", "frame:second"], () => group("second"));

  const targetedBefore = state.lifetime.targetedVisits;
  const maintenanceBefore = state.lifetime.maintenanceVisits;
  cache.evictIdentity("frame:first");
  expect(state.lifetime.targetedVisits - targetedBefore).toBe(1);
  expect(state.lifetime.maintenanceVisits - maintenanceBefore).toBeLessThanOrEqual(16);
  expect(state.ownerEntries(first)).toBe(0);
  expect(state.ownerEntries(second)).toBe(1);

  cache.clearOwner(first);
  expect(state.ownerEntries(second)).toBe(1);
  cache.clearOwner(second);
  expect(state.lifetime.records).toBe(0);
  expect(state.lifetime.dependencyBuckets).toBe(0);
});

test("service teardown detaches resource markers and drops reverse metadata", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const resource = {};
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  expect(cache.marker(resource, "resource", subscribe)).toBe(cache.marker(resource, "resource", subscribe));
  cache.getOrCreate(owner, 0, layout("teardown"), [{ binding: 0, key: "resource" }], ["resource"], () => group("resource"));

  expect(subscribe).toHaveBeenCalledTimes(1);
  cache.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(state.lifetime.records).toBe(0);
  expect(state.lifetime.dependencyBuckets).toBe(0);
});

test("rotating maintenance passes live records and removes a dead record within the 16-visit budget", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const bgl = layout("sweep");
  for (let index = 0; index < 20; index += 1) {
    cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: index }], [index], () => group(String(index)));
  }
  state.lifetime.forceDead(state.lifetime.recordIds.at(-1)!);

  for (let attempt = 0; attempt < 2 && state.lifetime.records === 20; attempt += 1) {
    const before = state.lifetime.maintenanceVisits;
    state.lifetime.maintain();
    expect(state.lifetime.maintenanceVisits - before).toBeLessThanOrEqual(16);
  }
  expect(state.lifetime.records).toBe(19);
});

test("age-gated page eviction keeps recent entries registered, drops stale and dead ones, and stays within the page bucket", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const bgl = layout("pages");
  const [stale, recent, dead, other] = [{}, {}, {}, {}];
  const range = (offset: number) => ({ kind: CAPTURE_PAGE_KIND, id: 7, offset, size: 16 });
  const take = (owner: object, offset: number, name: string) =>
    cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: range(offset) }], [range(offset)], () => group(name));
  take(stale, 0, "stale");
  take(dead, 512, "dead");
  cache.getOrCreate(other, 0, bgl, [{ binding: 0, key: "unrelated" }], ["unrelated"], () => group("unrelated"));
  const mark = bindGroupClock();
  const kept = take(recent, 256, "recent");
  state.lifetime.forceDead(state.lifetime.recordIds[1]!);

  const targetedBefore = state.lifetime.targetedVisits;
  cache.evictIdentity({ kind: CAPTURE_PAGE_KIND, id: 7 }, mark);
  // Only the page bucket is visited; maintenance may already have swept the dead record.
  expect(state.lifetime.targetedVisits - targetedBefore).toBeLessThanOrEqual(3);
  expect(state.ownerEntries(stale)).toBe(0);
  expect(state.ownerEntries(recent)).toBe(1);
  expect(state.ownerEntries(other)).toBe(1);
  expect(state.lifetime.records).toBe(2);
  expect(take(recent, 256, "unexpected")).toBe(kept);

  cache.evictIdentity({ kind: CAPTURE_PAGE_KIND, id: 7 });
  expect(state.ownerEntries(recent)).toBe(0);
  expect(state.lifetime.records).toBe(1);
});

test("clearing one group retires its entries across layouts and keeps the owner's other groups", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const kept = cache.getOrCreate(owner, 0, layout("static-0"), [{ binding: 0, key: "A" }], ["A"], () => group("group-0"));
  cache.getOrCreate(owner, 1, layout("static-1"), [{ binding: 0, key: "A" }], ["A"], () => group("group-1"));
  cache.getOrCreate(owner, 1, layout("dynamic-1"), [{ binding: 0, key: "A" }], ["A"], () => group("group-1-dynamic"));

  cache.clearOwner(owner, 1);
  expect(state.ownerEntries(owner)).toBe(1);
  expect(state.lifetime.records).toBe(1);
  expect(cache.getOrCreate(owner, 0, layout("unused"), [{ binding: 0, key: "A" }], ["A"], () => group("other-layout"))).not.toBe(kept);
});

test("cache hits, keyed or not, do no lifetime maintenance and keyed hits build no binding key", () => {
  const cache = createBindGroupCache();
  const state = bindGroupCacheTestState(cache);
  const owner = {};
  const bgl = layout("hits");
  for (let index = 0; index < 20; index += 1) cache.getOrCreate(owner, 0, bgl, [{ binding: 0, key: index }], [index], () => group(String(index)));
  const bindings = [{ binding: 1, key: "B" }, { binding: 0, key: "A" }];
  const created = cache.getOrCreate(owner, 1, bgl, bindings, ["A", "B"], () => group("AB"));
  const key = bindGroupKeyOf(bindings);
  expect(key).toBe(bindGroupKeyOf([...bindings].reverse()));
  const before = { visits: state.lifetime.maintenanceVisits, targeted: state.lifetime.targetedVisits, records: state.lifetime.records, keys: state.bindingKeyBuilds };
  for (let index = 0; index < 10; index += 1) {
    expect(cache.getOrCreate(owner, 1, bgl, bindings, ["A", "B"], () => group("unexpected"), key)).toBe(created);
  }
  expect(state.bindingKeyBuilds).toBe(before.keys);
  expect(cache.getOrCreate(owner, 1, bgl, bindings, ["A", "B"], () => group("unexpected"))).toBe(created);
  expect(state.bindingKeyBuilds).toBe(before.keys + 1);
  expect(state.lifetime.maintenanceVisits).toBe(before.visits);
  expect(state.lifetime.targetedVisits).toBe(before.targeted);
  expect(state.lifetime.records).toBe(before.records);
  // A miss still registers and sweeps within the bounded budget.
  cache.getOrCreate(owner, 1, bgl, [{ binding: 0, key: "C" }], ["C"], () => group("C"));
  expect(state.lifetime.maintenanceVisits - before.visits).toBeGreaterThan(0);
  expect(state.lifetime.maintenanceVisits - before.visits).toBeLessThanOrEqual(16);
});

test("a keyed hit refreshes LRU recency like an unkeyed one", () => {
  const cache = createBindGroupCache();
  const owner = {};
  const bgl = layout("keyed-lru");
  const part = (index: number) => [{ binding: 0, key: index }];
  const groups = Array.from({ length: 64 }, (_, index) => cache.getOrCreate(owner, 0, bgl, part(index), [index], () => group(String(index))));
  expect(cache.getOrCreate(owner, 0, bgl, part(0), [0], () => group("unexpected"), bindGroupKeyOf(part(0)))).toBe(groups[0]);
  cache.getOrCreate(owner, 0, bgl, part(64), [64], () => group("64"), bindGroupKeyOf(part(64)));
  expect(cache.getOrCreate(owner, 0, bgl, part(0), [0], () => group("unexpected"))).toBe(groups[0]);
  expect(cache.getOrCreate(owner, 0, bgl, part(1), [1], () => group("replacement-1"))).not.toBe(groups[1]);
});
