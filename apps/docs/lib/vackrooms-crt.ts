import { isVackroomsOrigin } from "./vackrooms-browser";

const SVG = "http://www.w3.org/2000/svg";
const PNG = "data:image/png;base64,";

interface CrtRequest {
  type: "vackrooms-crt";
  version: 1;
  requestId: string;
  curvature: string;
  scale: number;
}

export function isCrtRequest(data: unknown): data is CrtRequest {
  if (!data || typeof data !== "object") return false;
  const value = data as Partial<CrtRequest>;
  const valid =
    value.type === "vackrooms-crt" &&
    value.version === 1 &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    typeof value.scale === "number" &&
    Number.isFinite(value.scale) &&
    value.scale >= 0 &&
    value.scale <= 24 &&
    typeof value.curvature === "string" &&
    value.curvature.length <= 300000 &&
    value.curvature.startsWith(`${PNG}iVBORw0KGgo`) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.curvature.slice(PNG.length));
  if (!valid) return false;
  try {
    // Validate the PNG IHDR before decoding, so a tiny payload cannot declare
    // a huge image allocation. The game sends one fixed-size 256 x 192 map.
    const header = atob(value.curvature!.slice(PNG.length, PNG.length + 44));
    const number = (offset: number) =>
      Array.from(header.slice(offset, offset + 4)).reduce(
        (total, character) => total * 256 + character.charCodeAt(0),
        0,
      );
    return (
      header.slice(12, 16) === "IHDR" &&
      number(16) === 256 &&
      number(20) === 192
    );
  } catch {
    return false;
  }
}

/** Applies a host-generated map to our own page; never captures website pixels. */
export function installVackroomsCrt(win: Window = window): () => void {
  if (win.parent === win) return () => {};
  const root = win.document.documentElement;
  const originalFilter = root.style.getPropertyValue("filter");
  const originalPriority = root.style.getPropertyPriority("filter");
  const baseFilter = win.getComputedStyle(root).filter;
  let definition: SVGElement | undefined;
  let filter: SVGElement | undefined;
  let map: SVGElement | undefined;
  let appliedFilter: string | undefined;
  let generation = 0;
  let disposed = false;

  const viewport = () => {
    if (!filter || !map) return;
    // Root filtering keeps fixed/sticky layout intact. The map tracks the
    // visible screen rather than stretching across the document's full height.
    const x = win.scrollX;
    const y = win.scrollY;
    filter.setAttribute("x", String(x - 12));
    filter.setAttribute("y", String(y - 12));
    filter.setAttribute("width", String(win.innerWidth + 24));
    filter.setAttribute("height", String(win.innerHeight + 24));
    map.setAttribute("x", String(x));
    map.setAttribute("y", String(y));
    map.setAttribute("width", String(win.innerWidth));
    map.setAttribute("height", String(win.innerHeight));
  };

  const apply = async (data: CrtRequest, origin: string) => {
    const revision = ++generation;
    const image = win.document.createElement("img");
    image.src = data.curvature;
    try {
      await image.decode();
    } catch {
      return;
    }
    if (
      disposed ||
      revision !== generation ||
      image.naturalWidth !== 256 ||
      image.naturalHeight !== 192
    )
      return;
    const make = (name: string, attributes: Record<string, string>) => {
      const node = win.document.createElementNS(SVG, name);
      for (const [key, value] of Object.entries(attributes))
        node.setAttribute(key, value);
      return node;
    };
    const id = `vackrooms-crt-${crypto.randomUUID()}`;
    const next = make("svg", {
      width: "0",
      height: "0",
      "aria-hidden": "true",
    });
    next.style.position = "absolute";
    next.style.pointerEvents = "none";
    filter = make("filter", {
      id,
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
    });
    map = make("feImage", {
      href: data.curvature,
      result: "curvature",
      preserveAspectRatio: "none",
    });
    filter.append(
      map,
      make("feDisplacementMap", {
        in: "SourceGraphic",
        in2: "curvature",
        scale: String(data.scale),
        xChannelSelector: "R",
        yChannelSelector: "G",
      }),
    );
    next.append(filter);
    win.document.body.append(next);
    definition?.remove();
    definition = next;
    viewport();
    appliedFilter = `${baseFilter && baseFilter !== "none" ? `${baseFilter} ` : ""}url("#${id}")`;
    root.style.setProperty("filter", appliedFilter);
    root.dataset.vackroomsCrt = "active";
    win.parent.postMessage(
      { type: "vackrooms-crt-applied", version: 1, requestId: data.requestId },
      origin,
    );
  };

  const message = (event: MessageEvent) => {
    if (
      event.source !== win.parent ||
      !isVackroomsOrigin(event.origin) ||
      !isCrtRequest(event.data)
    )
      return;
    void apply(event.data, event.origin);
  };
  win.addEventListener("message", message);
  win.addEventListener("scroll", viewport, { passive: true });
  win.addEventListener("resize", viewport);
  win.parent.postMessage({ type: "vackrooms-crt-ready", version: 1 }, "*");
  return () => {
    disposed = true;
    ++generation;
    win.removeEventListener("message", message);
    win.removeEventListener("scroll", viewport);
    win.removeEventListener("resize", viewport);
    if (root.style.getPropertyValue("filter") === appliedFilter) {
      if (originalFilter)
        root.style.setProperty("filter", originalFilter, originalPriority);
      else root.style.removeProperty("filter");
    }
    delete root.dataset.vackroomsCrt;
    definition?.remove();
  };
}
