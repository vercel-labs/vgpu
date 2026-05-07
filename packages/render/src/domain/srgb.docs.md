# srgb

Converts colors from sRGB into linear RGB.

The input is sRGB: the way humans, design tools, and hex color pickers usually describe colors. The output is linear RGB in the `0..1` range, which is the color space shaders need for lighting math.

```ts
const baseColor = srgb(0xcc8844);
```

You can pass a packed hex value such as `0xff6600`, or a three-component sRGB tuple such as `[0.5, 0.5, 0.5]`.
