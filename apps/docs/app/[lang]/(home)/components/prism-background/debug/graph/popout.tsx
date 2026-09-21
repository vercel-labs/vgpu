"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const POPOUT_FEATURES =
  "popup=yes,width=1400,height=860,resizable=yes,scrollbars=no";
const STYLE_SELECTOR = 'link[rel="stylesheet"], style';
const MIRRORED_STYLE_ATTRIBUTE = "data-prism-debug-popup-style";

export interface DebugPopout {
  readonly blocked: boolean;
  readonly document: Document | null;
  dock(): void;
  open(): void;
}

/** Owns one same-origin auxiliary window for the lifetime of the debug graph. */
export function useDebugPopout(): DebugPopout {
  const popupRef = useRef<Window | null>(null);
  const closeListenerRef = useRef<(() => void) | null>(null);
  const stopStyleMirrorRef = useRef<(() => void) | null>(null);
  const [popupDocument, setPopupDocument] = useState<Document | null>(null);
  const [blocked, setBlocked] = useState(false);

  const release = useCallback((closeWindow: boolean) => {
    const popup = popupRef.current;
    const listener = closeListenerRef.current;
    const stopStyleMirror = stopStyleMirrorRef.current;
    popupRef.current = null;
    closeListenerRef.current = null;
    stopStyleMirrorRef.current = null;
    stopStyleMirror?.();
    if (popup && listener) {
      popup.removeEventListener("beforeunload", listener);
      popup.removeEventListener("pagehide", listener);
    }
    setPopupDocument(null);
    if (closeWindow && popup && !popup.closed) {
      // Let React unmount the portal and release its GPU preview canvases
      // before the browser destroys their owner document.
      window.setTimeout(() => {
        if (!popup.closed) popup.close();
      }, 0);
    }
  }, []);

  const open = useCallback(() => {
    const current = popupRef.current;
    if (current && !current.closed) {
      current.focus();
      return;
    }
    if (current) release(false);

    // This must stay synchronous with the click or browsers may block it.
    let popup: Window | null;
    try {
      popup = window.open("", "_blank", POPOUT_FEATURES);
    } catch {
      setBlocked(true);
      return;
    }
    if (!popup) {
      setBlocked(true);
      return;
    }

    try {
      preparePopupDocument(document, popup.document);
      stopStyleMirrorRef.current = mirrorPopupStyles(document, popup.document);
    } catch {
      popup.close();
      setBlocked(true);
      return;
    }

    const handleClose = () => {
      if (popupRef.current !== popup) return;
      popupRef.current = null;
      closeListenerRef.current = null;
      stopStyleMirrorRef.current?.();
      stopStyleMirrorRef.current = null;
      setPopupDocument(null);
    };
    popupRef.current = popup;
    closeListenerRef.current = handleClose;
    popup.addEventListener("beforeunload", handleClose, { once: true });
    popup.addEventListener("pagehide", handleClose, { once: true });
    setBlocked(false);
    setPopupDocument(popup.document);
    popup.focus();
  }, [release]);

  const dock = useCallback(() => release(true), [release]);

  useEffect(() => {
    if (!popupDocument) return;
    const interval = window.setInterval(() => {
      if (popupRef.current?.closed) release(false);
    }, 750);
    return () => window.clearInterval(interval);
  }, [popupDocument, release]);

  useEffect(
    () => () => {
      const popup = popupRef.current;
      const listener = closeListenerRef.current;
      const stopStyleMirror = stopStyleMirrorRef.current;
      popupRef.current = null;
      closeListenerRef.current = null;
      stopStyleMirrorRef.current = null;
      stopStyleMirror?.();
      if (popup && listener) {
        popup.removeEventListener("beforeunload", listener);
        popup.removeEventListener("pagehide", listener);
      }
      if (popup && !popup.closed) popup.close();
    },
    []
  );

  return { blocked, document: popupDocument, dock, open };
}

export function DebugPopoutPortal({
  children,
  document: popupDocument,
}: {
  readonly children: React.ReactNode;
  readonly document: Document;
}) {
  return createPortal(children, popupDocument.body);
}

function preparePopupDocument(source: Document, target: Document): void {
  const base = target.createElement("base");
  base.href = source.baseURI;
  const viewport = target.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const title = target.createElement("title");
  title.textContent = "vgpu · Prism debugger";

  target.head.replaceChildren(base, viewport, title);
  syncPopupStyles(source, target);

  target.documentElement.className = source.documentElement.className;
  target.documentElement.lang = source.documentElement.lang;
  target.documentElement.style.background = "#000";
  target.documentElement.style.colorScheme = "dark";
  target.body.replaceChildren();
  target.body.className = "prism-debug-popout-body";
  Object.assign(target.body.style, {
    background: "#000",
    height: "100vh",
    margin: "0",
    overflow: "hidden",
    width: "100vw",
  });
}

function mirrorPopupStyles(source: Document, target: Document): () => void {
  const observer = new MutationObserver(() => syncPopupStyles(source, target));
  observer.observe(source.head, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

function syncPopupStyles(source: Document, target: Document): void {
  for (const mirrored of target.head.querySelectorAll(
    `[${MIRRORED_STYLE_ATTRIBUTE}]`
  )) {
    mirrored.remove();
  }
  for (const sourceStyle of source.querySelectorAll(STYLE_SELECTOR)) {
    const clone = sourceStyle.cloneNode(true) as HTMLElement;
    clone.setAttribute(MIRRORED_STYLE_ATTRIBUTE, "");
    if (sourceStyle instanceof HTMLLinkElement)
      clone.setAttribute("href", sourceStyle.href);
    target.head.appendChild(clone);
  }
}
