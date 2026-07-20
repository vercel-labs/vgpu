import { pingPong } from "../src/index.ts";
import type {
  BufferOptions,
  BufferPingPong,
  Device,
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
