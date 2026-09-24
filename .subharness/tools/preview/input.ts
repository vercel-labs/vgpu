// Pointer and keyboard input for the capture: mouse or touch, with targets given as viewport points
// or as elements resolved at the moment the step runs.
import type { ChromePage } from "./chrome.ts";
import { rectExpression } from "./page-scripts.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A viewport point in CSS px, or a point inside an element's box (`at` in 0–1, default centre). */
export type Anchor = Point | { readonly selector: string; readonly at?: Point };

export type PointerKind = "mouse" | "touch";

export interface Pointer {
  x: number;
  y: number;
  pressed: boolean;
}

export async function resolveAnchor(page: ChromePage, anchor: Anchor): Promise<Point> {
  if (!("selector" in anchor)) return anchor;
  const response = await page.send("Runtime.evaluate", { expression: rectExpression(anchor.selector, anchor.at), returnByValue: true }) as { result?: { value?: Point | null } };
  const point = response.result?.value;
  if (!point) throw new Error(`No element matches ${anchor.selector}.`);
  return { x: point.x, y: point.y };
}

/**
 * Moves the pointer through `points` over `durationMs` in ~16 ms steps, so the page sees realistic
 * velocity (a short duration is a flick). While pressed, touch pointers emit touchMove.
 */
export async function glide(page: ChromePage, pointer: Pointer, kind: PointerKind, points: readonly Point[], durationMs: number): Promise<void> {
  if (points.length === 0) return;
  const frames = Math.max(points.length, Math.round(durationMs / 16));
  const route = [{ x: pointer.x, y: pointer.y }, ...points];
  for (let frame = 1; frame <= frames; frame++) {
    const along = (frame / frames) * (route.length - 1);
    const segment = Math.min(route.length - 2, Math.floor(along));
    const t = along - segment;
    pointer.x = route[segment].x + (route[segment + 1].x - route[segment].x) * t;
    pointer.y = route[segment].y + (route[segment + 1].y - route[segment].y) * t;
    if (kind === "touch") {
      if (pointer.pressed) await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pointer.x, y: pointer.y, id: 1 }] });
    } else {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pointer.x, y: pointer.y, button: pointer.pressed ? "left" : "none", buttons: pointer.pressed ? 1 : 0 });
    }
    await sleep(durationMs / frames);
  }
}

export async function press(page: ChromePage, pointer: Pointer, kind: PointerKind, down: boolean): Promise<void> {
  pointer.pressed = down;
  if (kind === "touch") {
    await page.send("Input.dispatchTouchEvent", down
      ? { type: "touchStart", touchPoints: [{ x: pointer.x, y: pointer.y, id: 1 }] }
      : { type: "touchEnd", touchPoints: [] });
    return;
  }
  await page.send("Input.dispatchMouseEvent", {
    type: down ? "mousePressed" : "mouseReleased",
    x: pointer.x,
    y: pointer.y,
    button: "left",
    buttons: down ? 1 : 0,
    clickCount: 1,
  });
}

/** Jumps a touch pointer (touch has no hover, so it teleports) or glides a mouse to `point`. */
export async function approach(page: ChromePage, pointer: Pointer, kind: PointerKind, point: Point): Promise<void> {
  if (kind === "touch" && !pointer.pressed) {
    pointer.x = point.x;
    pointer.y = point.y;
    return;
  }
  await glide(page, pointer, kind, [point], 60);
}

const namedKeys: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  " ": { code: "Space", keyCode: 32, text: " " },
  Space: { code: "Space", keyCode: 32, text: " " },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

/**
 * Presses a key the way a user does: keyDown with text (so Enter and Space activate buttons and
 * printable keys type) then keyUp. Accepts named keys (Enter, Escape, Tab, arrows, " "/Space, ...)
 * and single characters; `modifiers` hold Alt/Control/Meta/Shift.
 */
export async function pressKey(page: ChromePage, key: string, modifiers: readonly (keyof typeof modifierBits)[] = []): Promise<void> {
  const named = namedKeys[key];
  const single = key.length === 1 ? key : undefined;
  const definition = named ?? (single
    ? { code: /[a-z]/i.test(single) ? `Key${single.toUpperCase()}` : /\d/.test(single) ? `Digit${single}` : "", keyCode: single.toUpperCase().charCodeAt(0), text: single }
    : undefined);
  if (!definition) throw new Error(`Unknown key ${key}; use a named key (${Object.keys(namedKeys).join(", ")}) or one character.`);
  const bits = modifiers.reduce((sum, name) => sum | modifierBits[name], 0);
  const text = bits & (modifierBits.Control | modifierBits.Meta | modifierBits.Alt) ? undefined : definition.text;
  const base = { key: key === "Space" ? " " : key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, nativeVirtualKeyCode: definition.keyCode, modifiers: bits };
  await page.send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
