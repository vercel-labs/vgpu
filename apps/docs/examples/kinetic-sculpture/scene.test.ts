import { describe, expect, test } from 'vitest';
import type { SceneNode } from 'vgpu/scene';

import {
  buildMobile,
  countShapes,
  createCollections,
  MAX_LEVELS,
  MESHES,
  MIN_LEVELS,
  poseMobile,
  rebuildMobile,
  shapeCapacity,
  type Mobile,
} from './scene';

const position = (node: SceneNode) => {
  const world = node.worldMatrix;
  return [world[12]!, world[13]!, world[14]!];
};
const positions = (nodes: readonly SceneNode[]) => nodes.map(position);

function descendants(node: SceneNode): Set<SceneNode> {
  const found = new Set<SceneNode>();
  const visit = (current: SceneNode) => {
    for (const child of current.children) {
      found.add(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

function mobile(levels = 4): Mobile {
  const built = buildMobile(createCollections(), levels);
  poseMobile(built, { time: 3.2, swing: 1, rootAngle: 0 });
  return built;
}

describe('hierarchy', () => {
  test('builds 2^levels pendants under real nested groups', () => {
    for (let levels = MIN_LEVELS; levels <= MAX_LEVELS; levels++) {
      const built = mobile(levels);
      expect(built.leaves).toHaveLength(2 ** levels);
      expect(built.arms).toHaveLength(2 ** levels - 1);
      expect(built.root.parent).toBe(built.anchor);
      const rootDescendants = descendants(built.root);
      for (const leaf of built.leaves) expect(rootDescendants.has(leaf)).toBe(true);
      // anchor → root → one arm per level → pendant.
      let depth = 0;
      for (let node: SceneNode | null = built.leaves[0]!; node && node !== built.anchor; node = node.parent) depth++;
      expect(depth).toBe(levels + 2);
    }
  });

  test('the root angle carries every descendant around the suspension axis', () => {
    const built = mobile();
    const before = positions(built.leaves);
    const turn = 0.7;
    poseMobile(built, { time: 3.2, swing: 1, rootAngle: turn });
    const after = positions(built.leaves);
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    before.forEach(([x, y, z], index) => {
      // A yaw about the anchor's vertical axis (x = z = 0): heights stay, x/z rotate.
      const [ax, ay, az] = after[index]!;
      expect(ay).toBeCloseTo(y!, 5);
      expect(ax).toBeCloseTo(c * x! + s * z!, 5);
      expect(az).toBeCloseTo(-s * x! + c * z!, 5);
    });
  });

  test('turning one branch moves only its own subtree', () => {
    const built = mobile();
    const branch = built.arms.find((arm) => arm.parent === built.arms[0])!;
    const inside = descendants(branch);
    const before = positions(built.leaves);
    branch.set({ rotation: [0, 0.3, 0.2] });
    const after = positions(built.leaves);
    let moved = 0;
    built.leaves.forEach((leaf, index) => {
      const distance = Math.hypot(...after[index]!.map((value, axis) => value - before[index]![axis]!));
      if (inside.has(leaf)) {
        expect(distance).toBeGreaterThan(1e-3);
        moved++;
      } else {
        expect(distance).toBe(0);
      }
    });
    expect(moved).toBe(built.leaves.length / 2);
  });

  test('bound instances follow their nodes after syncWorlds', () => {
    const collections = createCollections();
    const built = buildMobile(collections, 3);
    poseMobile(built, { time: 1, swing: 1, rootAngle: 0.4 });
    for (const mesh of MESHES) expect(collections[mesh].syncWorlds()).toBe(collections[mesh].count);
  });
});

describe('animation', () => {
  test('poses are a closed-form function of time: no drift after a long session', () => {
    const direct = mobile(5);
    const stepped = mobile(5);
    poseMobile(direct, { time: 3600, swing: 0.8, rootAngle: 0.3 });
    for (let time = 0; time < 3600; time += 7.3) poseMobile(stepped, { time, swing: 1.2, rootAngle: -1 });
    poseMobile(stepped, { time: 3600, swing: 0.8, rootAngle: 0.3 });
    expect(positions(stepped.leaves)).toEqual(positions(direct.leaves));
  });

  test('swing 0 leaves every arm at its rest yaw while the gimbals keep spinning', () => {
    const built = mobile();
    poseMobile(built, { time: 1, swing: 0, rootAngle: 0 });
    const rest = positions(built.arms);
    poseMobile(built, { time: 9, swing: 0, rootAngle: 0 });
    expect(positions(built.arms)).toEqual(rest);
  });

  test('pendants never pass through each other at full swing', () => {
    const meshes = new Set<string>(MESHES);
    // The first visible shape under each pendant; its largest world axis bounds the body.
    const bodies = (built: Mobile) =>
      built.leaves.map((leaf) => {
        let node = leaf;
        while (!meshes.has(node.label ?? '')) node = node.children[0]!;
        return node;
      });
    for (let levels = MIN_LEVELS; levels <= MAX_LEVELS; levels++) {
      const built = mobile(levels);
      const shapes = bodies(built);
      let closest = Infinity;
      for (let time = 0; time < 90; time += 0.25) {
        poseMobile(built, { time, swing: 1.5, rootAngle: 0 });
        const spheres = shapes.map((node) => {
          const world = node.worldMatrix;
          const axis = (column: number) => Math.hypot(world[column * 4]!, world[column * 4 + 1]!, world[column * 4 + 2]!);
          // 1.075 covers the torus tube around its unit major radius.
          return { center: position(node), radius: Math.max(axis(0), axis(1), axis(2)) * 1.075 };
        });
        for (let i = 0; i < spheres.length; i++) {
          for (let j = i + 1; j < spheres.length; j++) {
            const [a, b] = [spheres[i]!, spheres[j]!];
            const gap = Math.hypot(...a.center.map((value, axis) => value - b.center[axis]!));
            closest = Math.min(closest, gap / (a.radius + b.radius));
          }
        }
      }
      expect(closest, `levels ${levels}`).toBeGreaterThan(1);
    }
  });

  test('the same seed builds the same mobile', () => {
    expect(positions(mobile(4).leaves)).toEqual(positions(mobile(4).leaves));
  });
});

describe('capacity and rebuild', () => {
  test('collections hold the largest level count', () => {
    const capacity = shapeCapacity();
    const largest = countShapes(MAX_LEVELS);
    for (const mesh of MESHES) expect(capacity[mesh]).toBe(largest[mesh]);
  });

  test('rebuilding across every level count reuses the collections exactly', () => {
    const collections = createCollections();
    let built = buildMobile(collections, 2);
    for (const levels of [5, 3, 4, 2, 5]) {
      built = rebuildMobile(collections, built, levels);
      const counts = countShapes(levels);
      for (const mesh of MESHES) expect(collections[mesh].count).toBe(counts[mesh]);
      expect(built.levels).toBe(levels);
    }
  });

  test('a build that would overflow throws before adding anything', () => {
    const collections = createCollections();
    buildMobile(collections, MAX_LEVELS);
    const before = MESHES.map((mesh) => collections[mesh].count);
    expect(() => buildMobile(collections, MAX_LEVELS)).toThrow(RangeError);
    expect(MESHES.map((mesh) => collections[mesh].count)).toEqual(before);
  });

  test('rejects level counts outside 2–5', () => {
    for (const levels of [1, 6, 2.5, Number.NaN]) {
      expect(() => buildMobile(createCollections(), levels)).toThrow(RangeError);
    }
  });

  test('the framed box covers the plinth and the suspension anchor at every level count', () => {
    for (let levels = MIN_LEVELS; levels <= MAX_LEVELS; levels++) {
      const built = mobile(levels);
      const [halfWidth, halfHeight] = built.extent;
      expect(halfWidth).toBeGreaterThanOrEqual(1.25);
      expect(built.center[1] - halfHeight).toBeLessThanOrEqual(0);
      expect(built.center[1] + halfHeight).toBeCloseTo(position(built.anchor)[1]!, 5);
    }
  });
});
