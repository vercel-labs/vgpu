import { describe, expect, test } from "vitest";
import {
  CAPTURE_PAGE_KIND,
  MAX_CAPTURE_VARIANTS,
  MAX_OWNER_ENTRIES,
  baseIdentityKey,
  bindGroupCacheTestState,
  bindGroupClock,
  createBindGroupCache,
  identityKey,
  type BindGroupCache,
  type BindGroupIdentityPart,
} from "../src/bind-cache.ts";

const page = (id: number, offset = 0, size = 64) => ({ kind: CAPTURE_PAGE_KIND, id, offset, size });
const buffer = (id: number) => ({ kind: "buffer", id });
const LAYOUT = {} as GPUBindGroupLayout;

/** Drives the owner-keyed cache like a draw: tuple position is the binding, every part is a dependency. */
function counting(cache: BindGroupCache) {
  let created = 0;
  const owners = new Map<number | string, object>();
  const owner = (draw: number | string) => {
    let value = owners.get(draw);
    if (!value) owners.set(draw, value = {});
    return value;
  };
  const get = (draw: number | string, group: number, tuple: readonly BindGroupIdentityPart[]) =>
    cache.getOrCreate(owner(draw), group, LAYOUT, tuple.map((key, binding) => ({ binding, key })), tuple, () => { created += 1; return { label: `${draw}:${group}:${created}` } as unknown as GPUBindGroup; });
  const clearDraw = (draw: number | string, group?: number) => cache.clearOwner(owner(draw), group);
  /** Index sizes over the owners this helper created; the cache itself keeps no enumerable owner registry. */
  const stats = () => {
    const state = bindGroupCacheTestState(cache);
    const counts = [...owners.values()].map(value => state.ownerEntries(value));
    return { entries: counts.reduce((sum, count) => sum + count, 0), draws: counts.filter(Boolean).length, dependencies: state.lifetime.dependencyBuckets };
  };
  return { get, clearDraw, stats, owner, created: () => created };
}

const empty = { entries: 0, draws: 0, dependencies: 0 };

describe("bind-group cache", () => {
  test("hits the same draw, group and tuple; anything else misses", () => {
    const cache = createBindGroupCache();
    const { get, clearDraw, created } = counting(cache);
    const first = get(1, 0, [buffer(1), buffer(2)]);
    expect(get(1, 0, [buffer(1), buffer(2)])).toBe(first);
    expect(created()).toBe(1);
    get(2, 0, [buffer(1), buffer(2)]);
    get(1, 1, [buffer(1), buffer(2)]);
    get(1, 0, [buffer(2), buffer(1)]);
    get(1, 0, [buffer(1)]);
    expect(created()).toBe(5);
    get(1, 1, [buffer(1)]);
    clearDraw(1, 0);
    get(1, 1, [buffer(1)]);
    expect(created()).toBe(6);
    get(1, 0, [buffer(1)]);
    expect(created()).toBe(7);
  });

  test("buffer ranges are distinct identities that share their base identity", () => {
    expect(identityKey(page(1, 256, 64))).toBe(`${CAPTURE_PAGE_KIND}:1@256+64`);
    expect(identityKey(buffer(3))).toBe("buffer:3");
    expect(identityKey("claimed")).toBe("string:claimed");
    expect(identityKey(7)).toBe("number:7");
    expect(identityKey("7")).not.toBe(identityKey(7));
    expect(baseIdentityKey(page(1, 256, 64))).toBe(`${CAPTURE_PAGE_KIND}:1`);
    expect(identityKey({ ...page(1, 256, 64) })).toBe(identityKey(page(1, 256, 64)));

    const cache = createBindGroupCache();
    const { get, created } = counting(cache);
    get(1, 0, [page(1, 0, 64)]);
    get(1, 0, [page(1, 256, 64)]);
    get(1, 0, [page(1, 0, 128)]);
    get(1, 0, [page(1, 256, 64)]);
    expect(created()).toBe(3);
  });

  test("evictIdentity removes every range of the base identity and nothing else", () => {
    const cache = createBindGroupCache();
    const { get, stats, created } = counting(cache);
    const tuples: [number, number, BindGroupIdentityPart[]][] = [
      [1, 0, [page(1, 0)]], [1, 1, [page(1, 256), buffer(9)]], [2, 0, [page(1, 512), page(1, 512)]],
      [3, 0, [{ kind: CAPTURE_PAGE_KIND, id: 1 }]], [4, 0, [page(2, 0)]], [5, 0, [buffer(9)]],
    ];
    for (const [draw, group, tuple] of tuples) get(draw, group, tuple);
    expect(created()).toBe(6);
    cache.evictIdentity({ kind: CAPTURE_PAGE_KIND, id: 1 });
    cache.evictIdentity({ kind: "buffer", id: 404 });
    for (const [draw, group, tuple] of tuples) get(draw, group, tuple);
    expect(created()).toBe(10);
    expect(stats().entries).toBe(6);
  });

  test("evictIdentity with a clock value keeps the entries used since then", () => {
    const cache = createBindGroupCache();
    const { get, created } = counting(cache);
    get(1, 0, [page(1, 0)]);
    get(2, 0, [page(1, 256)]);
    const mark = bindGroupClock();
    get(1, 0, [page(1, 0)]);
    cache.evictIdentity({ kind: CAPTURE_PAGE_KIND, id: 1 }, mark);
    get(1, 0, [page(1, 0)]);
    expect(created()).toBe(2);
    get(2, 0, [page(1, 256)]);
    expect(created()).toBe(3);
  });

  test("clearDraw removes only that draw, even when ids share a prefix", () => {
    const cache = createBindGroupCache();
    const { get, clearDraw, stats, created } = counting(cache);
    get(1, 0, [buffer(1)]);
    get(10, 0, [buffer(1)]);
    get("compute:3", 0, [buffer(2)]);
    get("compute:30", 0, [buffer(2)]);
    clearDraw(1);
    clearDraw("compute:3");
    expect(stats()).toMatchObject({ entries: 2, draws: 2 });
    expect(() => cache.evictIdentity(buffer(404))).not.toThrow();
    get(10, 0, [buffer(1)]);
    get("compute:30", 0, [buffer(2)]);
    expect(created()).toBe(4);
    get(1, 0, [buffer(1)]);
    expect(created()).toBe(5);
    get(1, 1, [buffer(1)]);
    clearDraw(1, 0);
    get(1, 1, [buffer(1)]);
    expect(created()).toBe(6);
    get(1, 0, [buffer(1)]);
    expect(created()).toBe(7);
  });

  test("captured variants are bounded per draw and group, least recently used first", () => {
    const cache = createBindGroupCache();
    const { get, stats, created } = counting(cache);
    const staticGroup = get(1, 0, [buffer(1)]);
    for (let i = 0; i < MAX_CAPTURE_VARIANTS; i++) get(1, 0, [page(1, i * 256)]);
    get(1, 0, [page(1, 0)]); // refreshes the oldest capture
    const newest = get(1, 0, [page(2, 0)]);
    expect(stats().entries).toBe(MAX_CAPTURE_VARIANTS + 1);
    expect(get(1, 0, [page(2, 0)])).toBe(newest);
    expect(get(1, 0, [buffer(1)])).toBe(staticGroup);
    const before = created();
    get(1, 0, [page(1, 0)]);
    expect(created()).toBe(before);
    get(1, 0, [page(1, 256)]); // the least recently used capture was evicted
    expect(created()).toBe(before + 1);
    for (let i = 0; i < MAX_CAPTURE_VARIANTS + 4; i++) get(2, 0, [page(3, i * 256)]);
    expect(stats().entries).toBe(2 * MAX_CAPTURE_VARIANTS + 1);
  });

  test("resource-only variants are bounded per owner too", () => {
    const cache = createBindGroupCache();
    const { get, stats } = counting(cache);
    for (let i = 0; i < MAX_OWNER_ENTRIES * 3; i++) get(1, 0, [{ kind: "external", id: 1, offset: i * 256, size: 16 }]);
    expect(stats().entries).toBe(MAX_OWNER_ENTRIES);
    for (let i = 0; i < MAX_OWNER_ENTRIES; i++) get(1, 0, [buffer(i)]);
    expect(stats().entries).toBe(MAX_OWNER_ENTRIES);
  });

  test("a throwing factory changes nothing", () => {
    const cache = createBindGroupCache();
    const { get, stats, owner } = counting(cache);
    get(1, 0, [buffer(1)]);
    const before = stats();
    expect(() => cache.getOrCreate(owner(1), 0, LAYOUT, [{ binding: 0, key: buffer(2) }], [buffer(2)], () => { throw new Error("native"); })).toThrow("native");
    expect(stats()).toEqual(before);
  });

  test("every index empties when the entries go, at scale", () => {
    const cache = createBindGroupCache();
    const { get, clearDraw, stats } = counting(cache);
    for (let draw = 0; draw < 3000; draw++) {
      for (let group = 0; group < 2; group++) {
        for (let variant = 0; variant < 4; variant++) get(draw, group, [page(1 + variant, (draw % 256) * 256), buffer(group)]);
      }
    }
    expect(stats().entries).toBe(24000);
    cache.evictIdentity({ kind: CAPTURE_PAGE_KIND, id: 2 });
    expect(stats().entries).toBe(18000);
    clearDraw(0);
    expect(stats().entries).toBe(17994);
    cache.evictIdentity(buffer(0));
    cache.evictIdentity(buffer(1));
    expect(stats()).toEqual(empty);
  });

  test("dispose empties the cache and leaves it usable", () => {
    const cache = createBindGroupCache();
    const { get, clearDraw, stats, created } = counting(cache);
    get(1, 0, [page(1)]);
    cache.dispose();
    expect(stats()).toEqual(empty);
    expect(() => { cache.evictIdentity(page(1)); clearDraw(1); }).not.toThrow();
    get(1, 0, [page(1)]);
    expect(created()).toBe(2);
  });
});
