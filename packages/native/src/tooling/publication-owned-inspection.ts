import { createHash } from "node:crypto";
import {
  parseMetalOutputRecord,
  type MetalOutputRecord,
} from "./output-record.js";
import {
  parseMetalPublicationPlan,
  type MetalPublicationPlan,
} from "./publication-recovery.js";

type Identity = Readonly<{ device: string; inode: string }>;
export interface OwnedPublicationInspection {
  readonly transactionId: string;
  readonly destinationName: string;
  readonly parent: Identity;
  readonly oldDestination: Identity;
  readonly length: number;
  readonly sha256: string;
  readonly nameMax: number;
  readonly pathMax: number;
  readonly outputRecord: MetalOutputRecord;
}

/** Receive only the bounded record from the helper's retained old directory. */
export async function readOwnedPublicationInspection(
  header: Record<string, unknown>,
  receive: () => Promise<Record<string, unknown>>,
  expected: Readonly<{ transactionId: string; destinationName: string }>
): Promise<OwnedPublicationInspection> {
  if (
    !keys(header, [
      "schemaVersion",
      "kind",
      "transactionId",
      "parent",
      "destinationName",
      "oldDestination",
      "record",
      "nameMax",
      "pathMax",
      "length",
      "sha256",
      "chunkCount",
    ]) ||
    header.schemaVersion !== 1 ||
    header.kind !== "owned-inspection" ||
    header.transactionId !== expected.transactionId ||
    header.destinationName !== expected.destinationName ||
    !identity(header.parent) ||
    !identity(header.oldDestination) ||
    !identity(header.record) ||
    header.oldDestination.device !== header.parent.device ||
    header.oldDestination.inode === header.parent.inode ||
    header.record.device !== header.parent.device ||
    header.record.inode === header.oldDestination.inode ||
    header.record.inode === header.parent.inode ||
    !integer(header.nameMax, 1, 255) ||
    !integer(header.pathMax, 1, 1023) ||
    !integer(header.length, 1, 65536) ||
    !digest(header.sha256) ||
    header.chunkCount !== Math.ceil(header.length / 16384)
  )
    throw new TypeError("Invalid owned publication inspection header");
  const bytes = Buffer.alloc(header.length);
  for (let index = 0; index < header.chunkCount; index++) {
    const frame = await receive();
    const length = Math.min(16384, bytes.length - index * 16384);
    if (
      !keys(frame, ["schemaVersion", "kind", "index", "hex"]) ||
      frame.schemaVersion !== 1 ||
      frame.kind !== "owned-record-chunk" ||
      frame.index !== index ||
      typeof frame.hex !== "string" ||
      frame.hex.length !== length * 2 ||
      !/^[0-9a-f]+$/u.test(frame.hex)
    )
      throw new TypeError("Invalid owned publication record chunk");
    Buffer.from(frame.hex, "hex").copy(bytes, index * 16384);
  }
  const complete = await receive();
  if (
    !keys(complete, ["schemaVersion", "kind", "transactionId"]) ||
    complete.schemaVersion !== 1 ||
    complete.kind !== "owned-inspection-complete" ||
    complete.transactionId !== expected.transactionId ||
    createHash("sha256").update(bytes).digest("hex") !== header.sha256
  )
    throw new TypeError("Unconfirmed owned publication record");
  const outputRecord = parseMetalOutputRecord(bytes);
  if (
    Buffer.byteLength(outputRecord.moduleName) > header.nameMax ||
    Buffer.byteLength(outputRecord.ownerConfiguration) > header.pathMax
  )
    throw new TypeError("Owned publication names exceed filesystem bounds");
  return Object.freeze({
    ...expected,
    parent: Object.freeze({ ...header.parent }),
    oldDestination: Object.freeze({ ...header.oldDestination }),
    length: header.length,
    sha256: header.sha256,
    nameMax: header.nameMax,
    pathMax: header.pathMax,
    outputRecord,
  });
}

/** Fixed approval grammar; C independently proves owner identity and old payloads. */
export function ownedPublicationApproval(
  inspection: OwnedPublicationInspection,
  configuration: Identity
): Buffer {
  const record = inspection.outputRecord;
  const old = inspection.oldDestination;
  const paths = [
    "Package.swift",
    `Sources/${record.moduleName}/Shaders.generated.swift`,
    `Sources/${record.moduleName}/Resources/Shaders.metallib`,
  ];
  const hashes = [
    ...paths.map(
      (path) => record.files.find((file) => file.path === path)!.sha256
    ),
    inspection.sha256,
  ];
  const ownerHex = Buffer.from(record.ownerConfiguration).toString("hex");
  return Buffer.from(
    `approve-owned ${inspection.transactionId} inspection ${old.device} ${old.inode} ${configuration.device} ${configuration.inode} ${inspection.length} ${inspection.sha256} ${record.moduleName} ${ownerHex}\n` +
      hashes.map((hash, index) => `old-artifact ${index} ${hash}\n`).join("")
  );
}

/** Freeze the complete old manifest only after joining the original live inspection. */
export function validateOwnedPublicationReady(
  ready: Record<string, unknown>,
  inspection: OwnedPublicationInspection,
  configuration: Identity
): Extract<MetalPublicationPlan, { renameMode: "swap" }> {
  const plan = parseMetalPublicationPlan(ready.publication, inspection.parent);
  if (
    !keys(ready, [
      "schemaVersion",
      "kind",
      "transactionId",
      "parent",
      "destinationName",
      "publication",
    ]) ||
    ready.schemaVersion !== 1 ||
    ready.kind !== "ready" ||
    ready.transactionId !== inspection.transactionId ||
    ready.destinationName !== inspection.destinationName ||
    !sameIdentity(ready.parent, inspection.parent) ||
    plan?.renameMode !== "swap" ||
    !sameIdentity(plan.oldDestination, inspection.oldDestination) ||
    plan.oldModuleName !== inspection.outputRecord.moduleName ||
    plan.oldRecordSHA256 !== inspection.sha256 ||
    plan.ownership.ownerConfiguration !==
      inspection.outputRecord.ownerConfiguration ||
    !sameIdentity(plan.ownership.configuration, configuration) ||
    plan.oldFiles[3]!.length !== inspection.length ||
    !plan.oldFiles.every(
      (file, index) =>
        file.sha256 ===
        (index === 3
          ? inspection.sha256
          : inspection.outputRecord.files.find(
              (entry) => entry.path === file.path
            )?.sha256)
    )
  )
    throw new TypeError(
      "Owned publication plan does not match the approved inspection"
    );
  return plan;
}

function keys(
  value: unknown,
  names: readonly string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function identity(value: unknown): value is Identity {
  return (
    keys(value, ["device", "inode"]) &&
    decimal(value.device) &&
    decimal(value.inode)
  );
}
function sameIdentity(value: unknown, expected: Identity): boolean {
  return (
    identity(value) &&
    value.device === expected.device &&
    value.inode === expected.inode
  );
}
function decimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/u.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  );
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
