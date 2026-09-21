import { describe, expect, test } from "vitest";

import {
  bloomFormatForLevel,
  FALLBACK_BLOOM_FORMAT,
  PACKED_BLOOM_FEATURE,
  PACKED_BLOOM_FORMAT,
  prismOptionalFeatures,
} from "./capabilities";

const supported = (...features: GPUFeatureName[]) => new Set(features);

describe("prism optional device features", () => {
  test.each([
    [undefined, false, []],
    [supported(), true, []],
    [supported(PACKED_BLOOM_FEATURE), false, [PACKED_BLOOM_FEATURE]],
    [
      supported("timestamp-query"),
      true,
      ["timestamp-query"],
    ],
    [
      supported(PACKED_BLOOM_FEATURE, "timestamp-query"),
      false,
      [PACKED_BLOOM_FEATURE],
    ],
    [
      supported(PACKED_BLOOM_FEATURE, "timestamp-query"),
      true,
      [PACKED_BLOOM_FEATURE, "timestamp-query"],
    ],
  ] as const)(
    "selects only supported features (%#)",
    (adapterFeatures, performanceSampling, expected) => {
      expect(
        prismOptionalFeatures(adapterFeatures, performanceSampling)
      ).toEqual(expected);
    }
  );
});

describe("bloom target formats", () => {
  test("uses packed RGB only for the three visible bloom levels", () => {
    const features = supported(PACKED_BLOOM_FEATURE);
    expect([0, 1, 2, 3].map((level) => bloomFormatForLevel(features, level)))
      .toEqual([
        PACKED_BLOOM_FORMAT,
        PACKED_BLOOM_FORMAT,
        PACKED_BLOOM_FORMAT,
        FALLBACK_BLOOM_FORMAT,
      ]);
  });

  test("keeps the rgba16float fallback byte-for-byte when disabled", () => {
    expect(
      [0, 1, 2, 3].map((level) => bloomFormatForLevel(supported(), level))
    ).toEqual(Array.from({ length: 4 }, () => FALLBACK_BLOOM_FORMAT));
  });
});
