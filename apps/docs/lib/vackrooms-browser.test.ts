import { expect, test, vi } from "vitest";
import {
  installVackroomsBrowser,
  isVackroomsOrigin,
} from "./vackrooms-browser";

function fixture() {
  const parent = { postMessage: vi.fn() };
  const navigation = Object.assign(new EventTarget(), {
    canGoBack: true,
    canGoForward: false,
    back: vi.fn(() => ({ finished: Promise.resolve() })),
    forward: vi.fn(() => ({ finished: Promise.resolve() })),
  });
  const originalOpen = vi.fn(() => null);
  const win = Object.assign(new EventTarget(), {
    parent,
    navigation,
    document: new EventTarget(),
    location: { href: "https://vgpu.sh/docs", assign: vi.fn() },
    open: originalOpen,
  });
  const send = (
    data: object,
    origin = "https://vackrooms.vercel.app",
    source = parent,
  ) => {
    win.dispatchEvent(
      Object.assign(new Event("message"), {
        data: {
          channel: "vackrooms-browser",
          version: 1,
          session: "test-session",
          ...data,
        },
        origin,
        source,
      }),
    );
  };
  const click = () => {
    const event = Object.assign(new Event("click", { cancelable: true }), {
      button: 0,
    });
    const anchor = {
      target: "_blank",
      href: "https://example.com/",
      hasAttribute: () => false,
    };
    Object.defineProperty(event, "target", {
      value: { closest: () => anchor },
    });
    win.document.dispatchEvent(event);
    return event;
  };
  const dispose = installVackroomsBrowser(win as unknown as Window);
  return { win, parent, navigation, originalOpen, send, click, dispose };
}

test("parent origins must be the game, Pablo previews, or local development", () => {
  for (const origin of [
    "https://vackrooms.vercel.app",
    "https://vackrooms-git-feature-pablostanley.vercel.app",
    "http://localhost:3008",
    "http://127.0.0.1:3009",
  ]) {
    expect(isVackroomsOrigin(origin)).toBe(true);
  }
  for (const origin of [
    "null",
    "https://vackrooms.vercel.app.evil.test",
    "https://vackrooms-other-account.vercel.app",
    "https://evil.test",
    "http://vackrooms.vercel.app",
    "https://vackrooms.vercel.app/path",
  ]) {
    expect(isVackroomsOrigin(origin)).toBe(false);
  }
});

test("standalone pages install no behavior", () => {
  const win = { addEventListener: vi.fn() } as unknown as Window;
  Object.defineProperty(win, "parent", { value: win });
  installVackroomsBrowser(win)();
  expect(win.addEventListener).not.toHaveBeenCalled();
});

test("untrusted parents and messages cannot retarget links or read page state", () => {
  const f = fixture();
  f.send({ type: "connect" }, "https://evil.test");
  f.send({ type: "connect" }, "https://vackrooms.vercel.app", {
    postMessage: vi.fn(),
  });
  f.send({ type: "connect", version: 2 });
  expect(f.click().defaultPrevented).toBe(false);
  expect(f.win.location.assign).not.toHaveBeenCalled();
  expect(f.win.open).toBe(f.originalOpen);
  expect(f.parent.postMessage).toHaveBeenCalledTimes(1);
  expect(f.parent.postMessage.mock.calls[0][0]).toEqual({
    channel: "vackrooms-browser",
    version: 1,
    type: "ready",
  });
  f.dispose();
});

test("connected links and window.open navigate this frame and cleanup restores behavior", () => {
  const f = fixture();
  f.send({ type: "connect" });
  expect(f.click().defaultPrevented).toBe(true);
  expect(f.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "navigate",
      session: "test-session",
      url: "https://example.com/",
    }),
    "https://vackrooms.vercel.app",
  );
  expect(f.win.location.assign).toHaveBeenLastCalledWith(
    "https://example.com/",
  );
  const open = f.win.open as Window["open"];
  expect(open("/examples", "_blank")).toBeNull();
  expect(f.win.location.assign).toHaveBeenLastCalledWith(
    "https://vgpu.sh/examples",
  );
  open("javascript:alert(1)", "_blank");
  expect(f.win.location.assign).toHaveBeenCalledTimes(2);
  expect(f.originalOpen).not.toHaveBeenCalled();
  f.dispose();
  expect(f.win.open).toBe(f.originalOpen);
  expect(f.click().defaultPrevented).toBe(false);
});

test("only current-session commands traverse this frame's Navigation API", async () => {
  const f = fixture();
  f.send({ type: "connect" });
  f.send({ type: "traverse", direction: "back", session: "stale" });
  f.send({ type: "traverse", direction: "forward" });
  expect(f.navigation.back).not.toHaveBeenCalled();
  expect(f.navigation.forward).not.toHaveBeenCalled();
  f.send({ type: "traverse", direction: "back" });
  await Promise.resolve();
  await Promise.resolve();
  expect(f.navigation.back).toHaveBeenCalledOnce();
  expect(f.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "state",
      session: "test-session",
      url: "https://vgpu.sh/docs",
      canGoBack: true,
      canGoForward: false,
    }),
    "https://vackrooms.vercel.app",
  );
  f.dispose();
});

test("Navigation API changes report fresh button state", () => {
  const f = fixture();
  f.send({ type: "connect" });
  f.navigation.canGoBack = false;
  f.navigation.canGoForward = true;
  f.navigation.dispatchEvent(new Event("currententrychange"));
  expect(f.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      canGoBack: false,
      canGoForward: true,
    }),
    "https://vackrooms.vercel.app",
  );
  f.dispose();
});
