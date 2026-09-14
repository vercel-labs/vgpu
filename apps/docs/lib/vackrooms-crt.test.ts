import { expect, test, vi } from "vitest";
import { installVackroomsCrt, isCrtRequest } from "./vackrooms-crt";

// Header-only input exercises pre-decode validation; the browser test uses
// the complete WebGPU-generated PNG and a real image decoder.
const pngHeader = new Uint8Array(33);
pngHeader.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
pngHeader.set([0, 0, 1, 0, 0, 0, 0, 192], 16);
const curvature = `data:image/png;base64,${btoa(String.fromCharCode(...pngHeader))}`;
const request = {
  type: "vackrooms-crt",
  version: 1,
  requestId: "test",
  curvature,
  scale: 20,
};

interface TestNode {
  attributes: Map<string, string>;
  children: TestNode[];
  style: { position: string; pointerEvents: string };
  setAttribute(name: string, value: string): void;
  append(...children: TestNode[]): void;
  remove: ReturnType<typeof vi.fn>;
}

function node(): TestNode {
  return {
    attributes: new Map<string, string>(),
    children: [],
    style: { position: "", pointerEvents: "" },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    append(...children: TestNode[]) {
      this.children.push(...children);
    },
    remove: vi.fn(),
  };
}

function fixture() {
  const styles = new Map<string, string>([["filter", "contrast(0.9)"]]);
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      getPropertyValue: (name: string) => styles.get(name) ?? "",
      getPropertyPriority: () => "",
      setProperty: (name: string, value: string) => {
        styles.set(name, value);
      },
      removeProperty: (name: string) => {
        styles.delete(name);
      },
    },
  };
  const parent = { postMessage: vi.fn() };
  const image = {
    src: "",
    naturalWidth: 256,
    naturalHeight: 192,
    decode: vi.fn(async () => {}),
  };
  const body = node();
  const win = Object.assign(new EventTarget(), {
    parent,
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1000,
    innerHeight: 600,
    getComputedStyle: () => ({ filter: "contrast(0.9)" }),
    document: {
      documentElement: root,
      body,
      createElement: vi.fn(() => image),
      createElementNS: () => node(),
    },
  });
  const send = (
    data: unknown = request,
    origin = "https://vackrooms.vercel.app",
    source = parent,
  ) => {
    win.dispatchEvent(
      Object.assign(new Event("message"), { data, origin, source }),
    );
  };
  const dispose = installVackroomsCrt(win as unknown as Window);
  return { win, root, styles, parent, image, body, send, dispose };
}

test("only bounded fixed-size PNG curvature requests are accepted", () => {
  expect(isCrtRequest(request)).toBe(true);
  for (const changed of [
    { scale: Infinity },
    { scale: 25 },
    { scale: -1 },
    { version: 2 },
    { requestId: "" },
    { requestId: "x".repeat(129) },
    { curvature: "data:image/svg+xml,<svg/>" },
    { curvature: `${curvature}${"A".repeat(300000)}` },
    { curvature: "https://vgpu.sh/map.png" },
  ])
    expect(isCrtRequest({ ...request, ...changed })).toBe(false);
  const huge = pngHeader.slice();
  huge.set([127, 255, 255, 255], 16);
  expect(
    isCrtRequest({
      ...request,
      curvature: `data:image/png;base64,${btoa(String.fromCharCode(...huge))}`,
    }),
  ).toBe(false);
});

test("foreign senders cannot decode a map or affect page styling", () => {
  const f = fixture();
  f.send(request, "https://evil.test");
  f.send(request, "https://vackrooms.vercel.app", { postMessage: vi.fn() });
  expect(f.image.decode).not.toHaveBeenCalled();
  expect(f.styles.get("filter")).toBe("contrast(0.9)");
  f.dispose();
});

test("map follows the visible viewport and cleanup restores prior filter", async () => {
  const f = fixture();
  f.send();
  await Promise.resolve();
  const definition = f.body.children[0];
  const filter = definition.children[0];
  const map = filter.children[0];
  expect(f.styles.get("filter")).toContain(
    'contrast(0.9) url("#vackrooms-crt-',
  );
  expect(f.root.dataset.vackroomsCrt).toBe("active");
  expect(map.attributes.get("width")).toBe("1000");
  f.win.scrollY = 900;
  f.win.innerHeight = 480;
  f.win.dispatchEvent(new Event("scroll"));
  expect(map.attributes.get("y")).toBe("900");
  expect(map.attributes.get("height")).toBe("480");
  expect(filter.attributes.get("y")).toBe("888");
  expect(f.parent.postMessage).toHaveBeenLastCalledWith(
    { type: "vackrooms-crt-applied", version: 1, requestId: "test" },
    "https://vackrooms.vercel.app",
  );
  f.dispose();
  expect(f.styles.get("filter")).toBe("contrast(0.9)");
  expect(definition.remove).toHaveBeenCalledOnce();
  expect(f.root.dataset.vackroomsCrt).toBeUndefined();
});

test("disposed decode results cannot install effects", async () => {
  const f = fixture();
  f.send();
  f.dispose();
  await Promise.resolve();
  expect(f.body.children).toHaveLength(0);
  expect(f.parent.postMessage).toHaveBeenCalledTimes(1);
});

test("only the most recent request installs a decoded map", async () => {
  const f = fixture();
  f.send();
  f.send({ ...request, requestId: "newer" });
  await Promise.resolve();
  expect(f.body.children).toHaveLength(1);
  expect(f.parent.postMessage).toHaveBeenLastCalledWith(
    { type: "vackrooms-crt-applied", version: 1, requestId: "newer" },
    "https://vackrooms.vercel.app",
  );
  f.dispose();
});

test("decoded dimensions must match the declared map dimensions", async () => {
  const f = fixture();
  f.image.naturalWidth = 2048;
  f.send();
  await Promise.resolve();
  expect(f.body.children).toHaveLength(0);
  f.dispose();
});
