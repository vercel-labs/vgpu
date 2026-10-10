import {
  initFromDevice as initBrowserFromDevice,
  type Gpu as BrowserGpu,
} from "vgpu";
import {
  initFromDevice as initNodeFromDevice,
  type Gpu as NodeGpu,
} from "vgpu/node";
import {
  initFromDevice as initMockFromDevice,
  type Gpu as MockGpu,
} from "vgpu/mock";
import type { Device } from "vgpu/core";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type BrowserLossType = Assert<Equal<BrowserGpu["lost"], Promise<GPUDeviceLostInfo>>>;
export type NodeLossType = Assert<Equal<NodeGpu["lost"], Promise<GPUDeviceLostInfo>>>;
export type MockLossType = Assert<Equal<MockGpu["lost"], Promise<GPUDeviceLostInfo>>>;

declare const device: GPUDevice;
declare let browserGpu: BrowserGpu;
declare let nodeGpu: NodeGpu;
declare let mockGpu: MockGpu;
declare const coreDevice: Device;

const browserLoss: Promise<GPUDeviceLostInfo> = browserGpu.lost;
const nodeLoss: Promise<GPUDeviceLostInfo> = nodeGpu.lost;
const mockLoss: Promise<GPUDeviceLostInfo> = mockGpu.lost;

// @ts-expect-error gpu.lost is stable and readonly
browserGpu.lost = browserLoss;
// @ts-expect-error gpu.lost is stable and readonly
nodeGpu.lost = nodeLoss;
// @ts-expect-error gpu.lost is stable and readonly
mockGpu.lost = mockLoss;
// @ts-expect-error observed loss is coordinated privately; core Device has no public lost API
coreDevice.lost;

async function entryReturns(): Promise<void> {
  const browser = await initBrowserFromDevice(device);
  const node = await initNodeFromDevice(device);
  const mock = await initMockFromDevice(device);
  const losses: readonly Promise<GPUDeviceLostInfo>[] = [browser.lost, node.lost, mock.lost];
  void losses;
}

void entryReturns;
