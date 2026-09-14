# Vackrooms browser integration

The site adapter activates only inside an iframe after a `connect` message from
Vackrooms production, a Pablo-owned Vackrooms preview, or localhost development.
The standalone site keeps its existing link behavior. Modifier-clicks and download
links retain native behavior.

The host and site use `postMessage` with `{ channel: "vackrooms-browser", version: 1 }`:

- Host → site: `{ type: "connect", session }`, with a new opaque session per requested navigation.
- Site → host: `{ type: "ready" }` after mounting; no page information is included.
- Site → host: `{ type: "state", session, url, canGoBack, canGoForward }` after connecting or changing the current history entry.
- Site → host: `{ type: "navigate", session, url }` before retargeting a popup, so the host can retain the destination for an external-tab fallback.
- Host → site: `{ type: "traverse", session, direction: "back" | "forward" }`.

The host must validate the iframe's `contentWindow`, expected origin and current
session before accepting state. It should connect on `load` and `ready`, and disable
history controls until a fresh state arrives. Site replies use the connecting
parent's exact origin.

Ordinary `_blank` links and `window.open(url)` then navigate the same iframe.
`window.open` returns `null` because no popup window was created. Back and Forward
use this frame's Navigation API entries. Browsers without that API report both
controls unavailable; the adapter never traverses the game's joint session history.

This needs both a deployed vgpu site change and a matching Vackrooms host handshake.
It does not give Vackrooms control over arbitrary websites. Destinations such as
GitHub can refuse embedding through their own frame policy; they still require the
host's external-tab fallback. Navigating to a site without an adapter also makes the
cooperative history controls unavailable.

## CRT curvature

The independent CRT adapter receives `{ type: "vackrooms-crt", version: 1,
requestId, curvature, scale }` from the same approved parent origins. `curvature`
must be a base64 PNG data URL, at most 300,000 characters, with both a declared
and decoded size of 256 × 192. `scale` is a finite value from 0 to 24 CSS pixels.
The host generates the RG displacement map with vgpu; this site never captures,
reads back, or sends any of its own pixels.

The site sends `{ type: "vackrooms-crt-ready", version: 1 }` when mounted and
`{ type: "vackrooms-crt-applied", version: 1, requestId }` after applying a valid
decoded map. The host should resend its map on iframe load or this ready signal,
and validate the source, origin and request ID of acknowledgments.

The SVG displacement filter applies to the site's own document root. Its map
tracks the visible viewport during scrolling and resizing, preserving fixed and
sticky controls. Existing root filtering is composed with the map and restored
on cleanup. Color grading and scanlines remain in the host's monitor glass so
they are not applied twice.
