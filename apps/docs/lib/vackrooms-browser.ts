const CHANNEL = "vackrooms-browser";

interface FrameNavigation extends EventTarget {
  canGoBack: boolean;
  canGoForward: boolean;
  back(): { finished: Promise<unknown> };
  forward(): { finished: Promise<unknown> };
}

export function isVackroomsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    if (url.protocol === "http:") {
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    }
    return (
      url.protocol === "https:" &&
      !url.port &&
      (url.hostname === "vackrooms.vercel.app" ||
        /^vackrooms-[a-z0-9-]+-pablostanley\.vercel\.app$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Site-owned opt-in: the embedding game cannot rewrite a foreign iframe. */
export function installVackroomsBrowser(win: Window = window): () => void {
  if (win.parent === win) return () => {};

  const navigation = (win as Window & { navigation?: FrameNavigation })
    .navigation;
  const originalOpen = win.open;
  let connection: { origin: string; session: string } | undefined;
  let traversing = false;
  const state = () => {
    if (!connection) return;
    win.parent.postMessage(
      {
        channel: CHANNEL,
        version: 1,
        type: "state",
        session: connection.session,
        url: win.location.href,
        canGoBack: !traversing && !!navigation?.canGoBack,
        canGoForward: !traversing && !!navigation?.canGoForward,
      },
      connection.origin,
    );
  };

  const sameFrame = (value: string | URL) => {
    try {
      const url = new URL(String(value), win.location.href);
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      if (connection) {
        win.parent.postMessage(
          {
            channel: CHANNEL,
            version: 1,
            type: "navigate",
            session: connection.session,
            url: url.href,
          },
          connection.origin,
        );
      }
      win.location.assign(url.href);
    } catch {
      // A malformed or non-web URL is not a new browser window.
    }
  };
  const open: Window["open"] = (url, target, features) => {
    if (!connection || (target && target.toLowerCase() !== "_blank")) {
      return originalOpen.call(win, url, target, features);
    }
    if (url) sameFrame(url);
    // No popup WindowProxy exists when navigation stays in this frame.
    return null;
  };
  const click = (event: MouseEvent) => {
    if (!connection || event.defaultPrevented || event.button !== 0) return;
    // Explicit modifier-clicks retain the user's normal browser behavior.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const target = event.target as Element | null;
    const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (
      !link ||
      link.target.toLowerCase() !== "_blank" ||
      link.hasAttribute("download")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sameFrame(link.href);
  };

  const message = (event: MessageEvent) => {
    if (event.source !== win.parent || !isVackroomsOrigin(event.origin)) return;
    const data = event.data;
    if (
      !data ||
      data.channel !== CHANNEL ||
      data.version !== 1 ||
      typeof data.session !== "string" ||
      !data.session ||
      data.session.length > 128
    )
      return;
    if (data.type === "connect") {
      connection = { origin: event.origin, session: data.session };
      win.open = open;
      state();
      return;
    }
    if (
      !connection ||
      event.origin !== connection.origin ||
      data.session !== connection.session ||
      data.type !== "traverse" ||
      (data.direction !== "back" && data.direction !== "forward")
    )
      return;
    const allowed =
      data.direction === "back"
        ? navigation?.canGoBack
        : navigation?.canGoForward;
    if (!navigation || traversing || !allowed) {
      state();
      return;
    }
    // Navigation API entries belong to this frame and this origin. Calling
    // history.back() instead would traverse the top-level joint history.
    traversing = true;
    state();
    try {
      void navigation[data.direction as "back" | "forward"]()
        .finished.catch(() => {})
        .finally(() => {
          traversing = false;
          state();
        });
    } catch {
      traversing = false;
      state();
    }
  };

  win.addEventListener("message", message);
  win.document.addEventListener("click", click, true);
  win.addEventListener("pageshow", state);
  navigation?.addEventListener("currententrychange", state);
  // No page information is disclosed until the parent opts in. This ready
  // signal also covers React hydration finishing after the iframe load event.
  win.parent.postMessage({ channel: CHANNEL, version: 1, type: "ready" }, "*");

  return () => {
    connection = undefined;
    win.removeEventListener("message", message);
    win.document.removeEventListener("click", click, true);
    win.removeEventListener("pageshow", state);
    navigation?.removeEventListener("currententrychange", state);
    if (win.open === open) win.open = originalOpen;
  };
}
