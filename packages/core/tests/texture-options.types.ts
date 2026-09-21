import type { Device, Texture, TextureOptions, TextureReadOptions, TextureShape } from "../src/index.ts";
import type { TextureOptions as PublicOptions, TextureShape as PublicShape, TextureReadOptions as PublicReadOptions, Target } from "vgpu";

declare const device: Device;
declare const core: TextureOptions;
declare const publicOptions: PublicOptions;
const samePublic: PublicOptions = core;
const sameCore: TextureOptions = publicOptions;
declare const shape: TextureShape;
const sameShape: PublicShape = shape;
void [samePublic, sameCore, sameShape];

const options = { format: "rgba8unorm", usage: ["texture_binding"] } as const;
const line: Texture = device.createTexture({ ...options, kind: "1d", size: [8] });
device.createTexture({ ...options, kind: "2d", size: [8, 4] });
device.createTexture({ ...options, kind: "3d", size: [8, 4, 2] });
device.createTexture({ ...options, kind: "2d-array", size: [8, 4], layers: 6 });
void line;
// @ts-expect-error a Texture has fixed structure; recreate and rebind it
line.resize([16]);

// @ts-expect-error kind is required even for 2D
device.createTexture({ ...options, size: [8, 4] });
// @ts-expect-error usage is required
device.createTexture({ kind: "2d", size: [8, 4], format: "rgba8unorm" });
// @ts-expect-error usage cannot be empty
device.createTexture({ ...options, kind: "2d", size: [8, 4], usage: [] });
// @ts-expect-error usage names are exact
device.createTexture({ ...options, kind: "2d", size: [8, 4], usage: ["sampled"] });
// @ts-expect-error array layers cannot be encoded in size
device.createTexture({ ...options, kind: "2d-array", size: [8, 4, 6] });
// @ts-expect-error arrays require layers
device.createTexture({ ...options, kind: "2d-array", size: [8, 4] });
// @ts-expect-error plain 2D cannot declare layers
device.createTexture({ ...options, kind: "2d", size: [8, 4], layers: 6 });
// @ts-expect-error 3D needs a spatial depth
device.createTexture({ ...options, kind: "3d", size: [8, 4] });
// @ts-expect-error 1D has exactly one spatial dimension
device.createTexture({ ...options, kind: "1d", size: [8, 1] });
// @ts-expect-error dimension is a native descriptor field, not a creation option
device.createTexture({ ...options, kind: "3d", size: [8, 4, 2], dimension: "3d" });
// @ts-expect-error unsupported sample count
device.createTexture({ ...options, kind: "2d", size: [8, 4], sampleCount: 2 });
// @ts-expect-error metadata is readonly
core.size[0] = 32;

declare const read: TextureReadOptions;
const publicRead: PublicReadOptions = read;
line.read(publicRead);
line.readFloats({ mipLevel: 0, region: { origin: [0, 0, 0], size: [1, 1, 1] } });
// @ts-expect-error selection is mandatory
line.read();
// @ts-expect-error float reads also require selection
line.readFloats();
// @ts-expect-error mipLevel is mandatory
line.read({ region: "all" });
// @ts-expect-error region is mandatory
line.read({ mipLevel: 0 });
// @ts-expect-error coordinates are always triples
line.read({ mipLevel: 0, region: { origin: [0, 0], size: [1, 1] } });
declare const output: Target;
// @ts-expect-error select an attachment instead of reading a container
output.read({ mipLevel: 0, region: "all" });
// @ts-expect-error target readFloats was removed too
output.readFloats({ mipLevel: 0, region: "all" });
output.color.read(read);
