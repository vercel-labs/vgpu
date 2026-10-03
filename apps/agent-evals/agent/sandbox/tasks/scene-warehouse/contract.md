# Warehouse renderer contract

Expose `node render.mjs /absolute/input.json /absolute/output-directory`. The output directory starts empty. Process every input frame in order in one process, dispose GPU resources, and write `result.json`, one color PNG, and one application-ID PNG per frame. Verification runs a fresh source copy, so paths must be portable.

Input contains `version:1`, `requestId`, an `items` array, and `frames`. Each item is:

```json
{"appId":10001,"position":[-23.5,23.5,0],"tint":[1,0,0,1]}
```

Application IDs are stable positive 24-bit identities, not array indices, collection handles, or packed slots. Render every input item as an axis-aligned side-0.6 box. Initial frames have `{"operations":[]}`.

Render 576×576 offscreen `rgba8unorm` with opaque black clear, depth, no MSAA, blending, lighting, tone mapping, or rescaling. Camera position is `[0,0,8]`, identity orientation, orthographic bounds `[-24,24]` on x/y, near/far `0.1/20`.

Color uses `tint`. The ID pass must use the same current geometry/state and write `[appId&255,(appId>>8)&255,(appId>>16)&255,255]`; its background is `[0,0,0,255]`.

Write live items sorted by `appId`:

```json
{"version":1,"requestId":"example","frames":[{"index":0,"color":"000-color.png","ids":"000-ids.png","state":{"count":1,"items":[{"appId":10001,"position":[-23.5,23.5,0],"tint":[1,0,0,1]}]}}]}
```

PNG rows use top-left origin. Filenames may differ but must be relative below the output directory. JSON numbers must be finite and frame indices/count/order, version, and request ID must match input.
