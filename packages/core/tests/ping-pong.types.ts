import { Buffer, Device, Queue, pingPong } from "../src/index.ts";
import type {
  BufferOptions,
  BufferPingPong,
  CreateDeviceOptions,
  TextureOptions,
  TexturePingPong,
} from "../src/index.ts";

declare const device: Device;
declare const textureOptions: TextureOptions;
declare const bufferOptions: BufferOptions;
declare const unionOptions: TextureOptions | BufferOptions;

const texturePair = pingPong(device, textureOptions);
const bufferPair = pingPong(device, bufferOptions);
const unionPair = pingPong(device, unionOptions);

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type _TextureOverload = Expect<Equal<typeof texturePair, TexturePingPong>>;
type _BufferOverload = Expect<Equal<typeof bufferPair, BufferPingPong>>;
type _UnionOverload = Expect<Equal<typeof unionPair, TexturePingPong | BufferPingPong>>;

const validDeviceOptions: CreateDeviceOptions = { requiredLimits: { maxStorageBuffersInVertexStage: 2 } };
void validDeviceOptions;
// @ts-expect-error misspelled WebGPU limit names are rejected
const invalidDeviceOptions: CreateDeviceOptions = { requiredLimits: { maxStorageBufferInVertexStage: 2 } };
void invalidDeviceOptions;

declare const rawDevice: GPUDevice;
declare const rawBuffer: GPUBuffer;
declare const rawQueue: GPUQueue;
new Device(rawDevice, null, { isCompatibilityMode: true });
new Buffer(device, rawBuffer, bufferOptions);
new Queue(rawQueue);
// @ts-expect-error ownership is inferred internally and is not a public constructor option
new Device(rawDevice, null, "external");
// @ts-expect-error Buffer ownership is an internal implementation detail
new Buffer(device, rawBuffer, bufferOptions, "external");
// @ts-expect-error Queue lifecycle guards cannot be injected by consumers
new Queue(rawQueue, () => undefined);
// @ts-expect-error lifecycle preflight is not public API
device.assertUsable("consumer");
