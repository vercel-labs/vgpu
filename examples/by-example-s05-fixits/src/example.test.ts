import { expect, test } from "vitest";
import { collectFixitMessages } from "./example.ts";

test("by-example §5 fix-it messages name missing bindings and R1 flips", async () => {
  const messages = await collectFixitMessages();
  expect(messages.join("\n")).toContain("was never set");
  expect(messages.join("\n")).toContain("Binding ownership cannot be changed");
});
