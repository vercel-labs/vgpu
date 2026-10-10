import { instances, type InstanceId } from "../../src/scene/instances.ts";

const empty = instances({ capacity: 1 });
const emptyId: InstanceId = empty.add();
empty.set(emptyId, {});

const allDefaulted = instances({
  capacity: 2,
  attributes: {
    tint: { format: "float32x4", default: [1, 1, 1, 1] },
    layer: { format: "uint32", default: 0 },
  },
});
allDefaulted.add();
allDefaulted.add({ tint: new Float32Array([1, 0, 0, 1]), layer: 2 });

const mixed = instances({
  capacity: 2,
  attributes: {
    temperature: "float32",
    cell: "sint32x2",
    color: { format: "float32x3", default: [1, 1, 1] },
  },
});
const mixedId = mixed.add({ temperature: 2, cell: new Int32Array([3, 4]) });
mixed.set(mixedId, { color: [0.5, 0.25, 1], temperature: 3 });

// @ts-expect-error collections with required attributes require an add argument.
mixed.add();
// @ts-expect-error temperature is required.
mixed.add({ cell: [0, 1] });
// @ts-expect-error scalar attributes accept numbers, not arrays.
mixed.add({ temperature: [2], cell: [0, 1] });
// @ts-expect-error vector attributes accept ArrayLike<number>, not numbers.
mixed.add({ temperature: 2, cell: 1 });
// @ts-expect-error unknown attributes are rejected.
mixed.add({ temperature: 2, cell: [0, 1], unknown: 4 });
// @ts-expect-error set accepts only declared attributes.
mixed.set(mixedId, { unknown: 4 });
// @ts-expect-error handles are branded and arbitrary numbers are not accepted.
mixed.remove(0);
