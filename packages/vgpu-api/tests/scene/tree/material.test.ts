import { describe, expect, test } from "vitest";
import { lambertMaterial, normalMaterial, shaderMaterial, unlitMaterial } from "../../../src/scene.ts";

function errorCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("scene materials", () => {
  test("color materials default to opaque white and update in place", () => {
    const material = unlitMaterial();
    expect([...material.color]).toEqual([1, 1, 1]);
    expect(material.opacity).toBe(1);

    const color = material.color;
    material.set({ color: [0.2, 0.5, 1], opacity: 0.5 });
    expect(material.color).toBe(color);
    expect(material.color[2]).toBe(1);
    expect(material.opacity).toBe(0.5);
  });

  test("kinds discriminate materials for the renderer", () => {
    expect(unlitMaterial().kind).toBe("unlit");
    expect(lambertMaterial().kind).toBe("lambert");
    expect(normalMaterial().kind).toBe("normal");
    expect(shaderMaterial("@fragment fn fs_main() {}").kind).toBe("shader");
  });

  test("color material validates inputs", () => {
    expect(errorCode(() => unlitMaterial({ color: [1, 1] as never }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => unlitMaterial().set({ opacity: 2 }))).toBe("VGPU-SCENE-VALUE-INVALID");
  });

  test("shaderMaterial merges plain-object values per binding and replaces the rest", () => {
    const material = shaderMaterial("@fragment fn fs_main() {}", {
      set: { params: { color: [1, 0, 0], intensity: 2 }, flag: 1 },
    });

    material.set({ params: { intensity: 4 } });
    expect(material.values.params).toEqual({ color: [1, 0, 0], intensity: 4 });

    material.set({ flag: 0 });
    expect(material.values.flag).toBe(0);
    expect(material.source).toContain("fs_main");
  });
});
