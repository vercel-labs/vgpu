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
