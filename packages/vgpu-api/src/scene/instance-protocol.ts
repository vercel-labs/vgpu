import type { InstanceAttributes, InstanceCollection, InstanceFormat } from "./instances.ts";

export interface InstanceProtocolAttribute {
  readonly name: string;
  readonly format: InstanceFormat;
  readonly offset: number;
}

export interface InstanceProtocolLayout {
  readonly capacity: number;
  readonly stride: number;
  readonly attributes: readonly InstanceProtocolAttribute[];
}

export interface InstanceProtocol {
  readonly layout: InstanceProtocolLayout;
  readonly records: Uint8Array;
  readonly count: number;
  readonly revision: number;
  readonly countRevision: number;
  slotRevision(slot: number): number;
  assertNotSyncing(operation?: string): void;
}

const protocols = new WeakMap<object, InstanceProtocol>();
interface InstanceProtocolTestingController {
  getRevision(): number;
  setRevision(value: number): void;
  getNextInstanceId(): number;
  setNextInstanceId(value: number): void;
}

const testingControllers = new WeakMap<object, InstanceProtocolTestingController>();

/** @internal Registers the CPU/bridge handshake for one collection. */
export function attachInstanceProtocol(
  collection: object,
  protocol: InstanceProtocol,
  testingController: InstanceProtocolTestingController,
): void {
  protocols.set(collection, protocol);
  testingControllers.set(collection, testingController);
}

/** @internal Returns immutable layout/state metadata and read access to owned packed records. */
export function getInstanceProtocol<A extends InstanceAttributes = {}>(
  collection: InstanceCollection<A>,
): InstanceProtocol;
export function getInstanceProtocol(collection: object): InstanceProtocol;
export function getInstanceProtocol(collection: object): InstanceProtocol {
  const protocol = protocols.get(collection);
  if (!protocol) throw new TypeError("Expected an instance collection created by instances().");
  return protocol;
}

/** @internal Test-only exhaustion seam; restores the prior revision even when the callback throws. */
export function withInstanceProtocolRevisionForTesting<T>(collection: object, revision: number, run: () => T): T {
  const controller = testingControllers.get(collection);
  if (!controller) throw new TypeError("Expected an instance collection created by instances().");
  const previous = controller.getRevision();
  controller.setRevision(revision);
  try {
    return run();
  } finally {
    controller.setRevision(previous);
  }
}

/** @internal Test-only exhaustion seam; restores the process-global identity counter after the callback. */
export function withInstanceIdCounterForTesting<T>(collection: object, nextId: number, run: () => T): T {
  const controller = testingControllers.get(collection);
  if (!controller) throw new TypeError("Expected an instance collection created by instances().");
  const previous = controller.getNextInstanceId();
  controller.setNextInstanceId(nextId);
  try {
    return run();
  } finally {
    controller.setNextInstanceId(previous);
  }
}
