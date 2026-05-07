# degToRad

Converts degrees to radians for numeric inputs such as camera field-of-view values.

Use it when a design, note, or UI control gives an angle in degrees but the render API expects radians:

```ts
const fovYRadians = degToRad(50);
```
