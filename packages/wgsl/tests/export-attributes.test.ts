import { expect, test } from "vitest";
import { parseModule } from "../src/runtime/parser.ts";
import { scan } from "../src/runtime/scanner.ts";

test("export attributes accepted and duplicate attribute rejected", () => { expect(parseModule(scan("@compute export fn main(){}" )).exports[0]?.name).toBe("main"); expect(parseModule(scan("export @compute fn main(){}" )).exports[0]?.name).toBe("main"); expect(() => parseModule(scan("@a export @b fn f(){}"))).toThrow(expect.objectContaining({ code: "VGPU-WGSL-EXP-NOTDECL" })); });
