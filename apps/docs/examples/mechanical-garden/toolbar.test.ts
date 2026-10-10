import { describe, expect, it, vi } from "vitest";

import { TOOLS } from "./input";
import { BRUSH_RADIUS } from "./terrain";
import { COMPACT_WIDTH, createToolbar, PAUSED_HINT, TOOL_HINTS, TOOL_LABELS, type ToolbarOptions } from "./toolbar";

/** Just enough of the DOM for the tool bar: elements with attributes, children and listeners. */
class FakeElement {
  tagName: string;
  className = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | undefined;
  listeners = new Map<string, Set<EventListener>>();
  textContent = "";
  innerHTML = "";
  hidden = false;
  disabled = false;
  type = "";
  title = "";
  value = "";
  min = "";
  max = "";
  step = "";
  offsetHeight = 0;
  ownerDocument = fakeDocument;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  get parentNode(): FakeElement | null {
    return this.parent ?? null;
  }

  append(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
  }

  insertBefore(child: FakeElement, reference: FakeElement | null) {
    if (!reference) return this.append(child);
    child.parent = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
  }

  focus() {
    fakeDocument.activeElement = this;
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node; node = node.parent ?? null) if (node === this) return true;
    return false;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    const value = { type, preventDefault: vi.fn(), ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(value as unknown as Event);
    return value;
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count + this.children.reduce((sum, child) => sum + child.listenerCount(), 0);
  }

  all(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = predicate(this) ? [this] : [];
    for (const child of this.children) found.push(...child.all(predicate));
    return found;
  }

  find(predicate: (element: FakeElement) => boolean): FakeElement {
    const found = this.all(predicate)[0];
    if (!found) throw new Error("No matching element");
    return found;
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown) {
    this.observed.push(target);
  }
  disconnect() {
    this.observed = [];
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
  activeElement: null as FakeElement | null,
  defaultView: { ResizeObserver: FakeResizeObserver },
};

function setup(overrides: Partial<ToolbarOptions> = {}, existing: FakeElement[] = []) {
  const container = new FakeElement("div");
  for (const child of existing) container.append(child);
  const options = {
    tool: "orbit",
    radius: 0.8,
    strength: 0.25,
    touch: false,
    onTool: vi.fn(),
    onRadius: vi.fn(),
    onStrength: vi.fn(),
    onClearDestination: vi.fn(),
    ...overrides,
  } satisfies ToolbarOptions;
  const toolbar = createToolbar(container as unknown as HTMLElement, options);
  const root = container.find((element) => element.className === "mg-toolbar");
  const button = (tool: string) => root.find((element) => element.dataset.tool === tool);
  const pressed = () => TOOLS.filter((tool) => button(tool).getAttribute("aria-pressed") === "true");
  const hint = root.find((element) => element.className === "mg-hint");
  const brush = root.find((element) => element.className === "mg-brush");
  const sliders = root.all((element) => element.tagName === "input");
  const clear = root.find((element) => element.className === "mg-clear");
  const paused = root.find((element) => element.className === "mg-paused");
  const style = root.find((element) => element.tagName === "style").textContent;
  return { container, options, toolbar, root, button, pressed, hint, brush, sliders, clear, paused, style };
}

describe("tool bar", () => {
  it("renders four labelled, keyboard-numbered tool buttons with the active one pressed", () => {
    const env = setup();
    expect(env.root.className).toBe("mg-toolbar");
    for (const [index, tool] of TOOLS.entries()) {
      const button = env.button(tool);
      expect(button.tagName).toBe("button");
      expect(button.type).toBe("button");
      expect(button.getAttribute("aria-label")).toBe(TOOL_LABELS[tool]);
      expect(button.getAttribute("aria-keyshortcuts")).toBe(`${index + 1}`);
    }
    expect(env.pressed()).toEqual(["orbit"]);
    expect(env.hint.textContent).toBe(TOOL_HINTS.orbit[0]);
    expect(env.hint.getAttribute("aria-live")).toBe("polite");
  });

  it("asks for a tool on click and on the number keys, and shows the tool it is told", () => {
    const env = setup();
    env.button("elevate").dispatch("click");
    expect(env.options.onTool).toHaveBeenLastCalledWith("elevate");
    // The renderer owns the tool: the bar only changes when setTool confirms it.
    expect(env.pressed()).toEqual(["orbit"]);

    const key = env.root.dispatch("keydown", { key: "4" });
    expect(env.options.onTool).toHaveBeenLastCalledWith("destination");
    expect(key.preventDefault).toHaveBeenCalled();
    env.root.dispatch("keydown", { key: "3", metaKey: true });
    env.root.dispatch("keydown", { key: "x" });
    expect(env.options.onTool).toHaveBeenCalledTimes(2);

    for (const tool of TOOLS) {
      env.toolbar.setTool(tool);
      expect(env.pressed()).toEqual([tool]);
      expect(env.hint.textContent).toBe(TOOL_HINTS[tool][0]);
      expect(env.brush.hidden).toBe(tool !== "elevate" && tool !== "lower");
      expect(env.clear.hidden).toBe(tool !== "destination");
    }
  });

  it("uses touch hints and 44 px targets on coarse pointers, in both layouts", () => {
    const env = setup({ touch: true, tool: "elevate" });
    expect(env.hint.textContent).toBe(TOOL_HINTS.elevate[1]);
    expect(env.brush.hidden).toBe(false);
    expect(env.root.dataset.pointer).toBe("coarse");
    expect(setup().root.dataset.pointer).toBe("fine");
    // The coarse sizing is keyed on the pointer alone, so a landscape phone or a tablet above the
    // compact width keeps thumb-sized buttons.
    expect(env.style).toContain('.mg-toolbar[data-pointer="coarse"] .mg-tool{min-height:44px;min-width:44px}');
    expect(env.style).toContain('.mg-toolbar[data-pointer="coarse"][data-layout="wide"] .mg-tool{height:44px');
  });

  it("goes before the Settings panel so the tools come first in tab order", () => {
    const canvas = new FakeElement("canvas");
    const gui = new FakeElement("div");
    const env = setup({ before: gui as unknown as Element }, [canvas, gui]);
    expect(env.container.children).toEqual([canvas, env.root, gui]);
    // A reference that is not a child of the container falls back to appending.
    const stray = setup({ before: new FakeElement("div") as unknown as Element }, [canvas]);
    expect(stray.container.children.at(-1)).toBe(stray.root);
  });

  it("explains, while paused in a sculpt tool, that the ground changes only on a step", () => {
    const env = setup({ tool: "elevate" });
    expect(env.paused.textContent).toBe(PAUSED_HINT[0]);
    expect(setup({ touch: true }).paused.textContent).toBe(PAUSED_HINT[1]);
    expect(env.paused.hidden).toBe(true);
    env.toolbar.setPaused(true);
    expect(env.paused.hidden).toBe(false);
    env.toolbar.setTool("orbit");
    expect(env.paused.hidden).toBe(true);
    env.toolbar.setTool("lower");
    expect(env.paused.hidden).toBe(false);
    env.toolbar.setPaused(false);
    expect(env.paused.hidden).toBe(true);
  });

  it("reports radius and strength from the sliders and is adjusting only while they are shown and engaged", () => {
    const env = setup({ tool: "elevate" });
    const [radius, strength] = env.sliders;
    expect(radius!.min).toBe(`${BRUSH_RADIUS.min}`);
    expect(radius!.max).toBe(`${BRUSH_RADIUS.max}`);
    expect(radius!.value).toBe("0.8");
    radius!.value = "1.2";
    radius!.dispatch("input");
    expect(env.options.onRadius).toHaveBeenLastCalledWith(1.2);
    strength!.value = "0.5";
    strength!.dispatch("input");
    expect(env.options.onStrength).toHaveBeenLastCalledWith(0.5);

    expect(env.toolbar.adjusting).toBe(false);
    env.brush.dispatch("pointerenter");
    expect(env.toolbar.adjusting).toBe(true);
    env.brush.dispatch("pointerleave");
    env.brush.dispatch("focusin");
    expect(env.toolbar.adjusting).toBe(true);
    env.toolbar.setTool("orbit");
    expect(env.toolbar.adjusting).toBe(false);
  });

  it("enables Clear destination only while a destination is set", () => {
    const env = setup({ tool: "destination" });
    expect(env.clear.disabled).toBe(true);
    env.toolbar.setDestination(true);
    expect(env.clear.disabled).toBe(false);
    env.clear.dispatch("click");
    expect(env.options.onClearDestination).toHaveBeenCalledOnce();
    env.toolbar.setDestination(false);
    expect(env.clear.disabled).toBe(true);
  });

  it("docks to the bottom edge below the compact width, where Settings starts closed", () => {
    const env = setup();
    expect(env.root.dataset.layout).toBe("wide");
    // 650 and 680 px used to put the wide bar under the open Settings panel.
    for (const width of [390, 650, 680, COMPACT_WIDTH - 1]) {
      env.toolbar.layout(width);
      expect(env.root.dataset.layout).toBe("compact");
    }
    env.toolbar.layout(COMPACT_WIDTH);
    expect(env.root.dataset.layout).toBe("wide");
    // Above it the wide bar is capped to the width the 236 px panel and its margins leave free.
    expect(COMPACT_WIDTH).toBe(720);
    expect(env.style).toContain("max-width:calc(100% - 292px)");
  });

  it("hands focus to the tool when the focused control hides or disables, so Tab keeps its place", () => {
    const env = setup({ tool: "elevate" });
    env.sliders[0]!.focus();
    env.toolbar.setTool("orbit");
    expect(fakeDocument.activeElement).toBe(env.button("orbit"));

    env.toolbar.setTool("destination");
    env.toolbar.setDestination(true);
    env.clear.focus();
    env.toolbar.setDestination(false);
    expect(fakeDocument.activeElement).toBe(env.button("destination"));

    // Focus elsewhere (the canvas) is never taken.
    const canvas = new FakeElement("canvas");
    canvas.focus();
    env.toolbar.setTool("elevate");
    env.toolbar.setTool("orbit");
    expect(fakeDocument.activeElement).toBe(canvas);
  });

  it("reports the docked bar height as it changes, so Settings can stop above it", () => {
    const onDock = vi.fn();
    const env = setup({ onDock });
    const observer = FakeResizeObserver.instances.at(-1)!;
    expect(observer.observed).toEqual([env.root]);
    env.root.offsetHeight = 120;
    env.toolbar.layout(COMPACT_WIDTH + 100);
    expect(onDock).not.toHaveBeenCalled();
    env.toolbar.layout(650);
    expect(onDock).toHaveBeenLastCalledWith(120);
    env.toolbar.layout(660);
    expect(onDock).toHaveBeenCalledOnce();
    // A tool with fewer controls shrinks the bar; the observer reports it.
    env.root.offsetHeight = 96;
    observer.callback();
    expect(onDock).toHaveBeenLastCalledWith(96);
    env.toolbar.layout(COMPACT_WIDTH);
    expect(onDock).toHaveBeenLastCalledWith(null);
    env.toolbar.dispose();
    expect(observer.observed).toEqual([]);
  });

  it("dispose removes its listeners and element once", () => {
    const env = setup();
    expect(env.root.listenerCount()).toBeGreaterThan(0);
    env.toolbar.dispose();
    env.toolbar.dispose();
    expect(env.root.listenerCount()).toBe(0);
    expect(env.container.children).toHaveLength(0);
  });
});
