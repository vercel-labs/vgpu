import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateSwiftIdentifier } from "../validation.js";

const journalName = ".vgpu-native-publication.json";
const stageName = ".vgpu-native-stage";
const updateName = ".vgpu-native-publication.update.json";
const chunkLimit = 16 * 1024;
const recordLimit = 64 * 1024;
type Identity = Readonly<{ device: string; inode: string }>;
type ObservedEntry = Identity &
  Readonly<{ kind: "directory" | "file" | "symlink" | "other" }>;

export type MetalPublicationPlan =
  | Readonly<{ renameMode: "excl"; expectedDestination: "missing" }>
  | Readonly<{
      renameMode: "replace-empty";
      expectedDestination: "empty";
      oldDestination: Identity;
    }>;

/** Recognize owned plan metadata; filesystem checks still determine publication authority. */
export function parseMetalPublicationPlan(
  value: unknown,
  parent: Identity,
  stage?: Identity
): MetalPublicationPlan | undefined {
  if (
    !decimal(parent?.device) ||
    !decimal(parent?.inode) ||
    (stage !== undefined && (!decimal(stage?.device) || !decimal(stage?.inode)))
  )
    return undefined;
  if (
    keys(value, ["renameMode", "expectedDestination"]) &&
    value.renameMode === "excl" &&
    value.expectedDestination === "missing"
  )
    return Object.freeze({
      renameMode: "excl",
      expectedDestination: "missing",
    });
  if (
    !keys(value, ["renameMode", "expectedDestination", "oldDestination"]) ||
    value.renameMode !== "replace-empty" ||
    value.expectedDestination !== "empty" ||
    !identity(value.oldDestination) ||
    value.oldDestination.device !== parent.device ||
    value.oldDestination.inode === parent.inode ||
    (stage !== undefined &&
      value.oldDestination.device === stage.device &&
      value.oldDestination.inode === stage.inode)
  )
    return undefined;
  return Object.freeze({
    renameMode: "replace-empty",
    expectedDestination: "empty",
    oldDestination: Object.freeze({
      device: value.oldDestination.device,
      inode: value.oldDestination.inode,
    }),
  });
}

/** Metadata recognition is not integrity, publication-outcome, or cleanup authority. */
export interface InterruptedMetalPublication {
  readonly transactionId: string;
  readonly phase: "intent" | "staging" | "prepared";
  readonly parent: Identity;
  readonly destinationName: string;
  readonly outputPath: string;
  readonly moduleName: string;
  readonly stage?: Identity & Readonly<{ name: string }>;
  readonly publication?: MetalPublicationPlan;
}

export interface MetalPublicationRecoveryReport {
  readonly transaction?: InterruptedMetalPublication;
  /** Validated metadata only; the live publisher must join this to its original receipt. */
  readonly prepared?: Readonly<{
    recordSHA256: string;
    files: readonly Readonly<{
      role: string;
      path: string;
      length: number;
      sha256: string;
    }>[];
  }>;
  readonly recoveryPaths: readonly string[];
}

/** Decode only the fixed read-only recovery branch, with a bounded outstanding frame. */
export async function readMetalPublicationRecovery(
  header: Record<string, unknown>,
  receive: () => Promise<Record<string, unknown>>,
  parentPath: string,
  mode: "recovery" | "reconciliation" = "recovery"
): Promise<MetalPublicationRecoveryReport> {
  if (
    !keys(header, [
      "schemaVersion",
      "kind",
      "parent",
      "journal",
      "nameMax",
      "length",
      "sha256",
      "chunkCount",
      "stage",
      "update",
      ...(mode === "reconciliation" ? ["destination"] : []),
    ]) ||
    header.schemaVersion !== 1 ||
    header.kind !== mode ||
    !identity(header.parent) ||
    !identity(header.journal) ||
    !integer(header.nameMax, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(header.length, 1, recordLimit) ||
    !digest(header.sha256) ||
    header.chunkCount !== Math.ceil(header.length / chunkLimit) ||
    !entry(header.stage) ||
    !entry(header.update) ||
    (mode === "reconciliation" && !entry(header.destination))
  )
    throw new TypeError("Invalid publication recovery header");
  const bytes = Buffer.alloc(header.length);
  for (let index = 0; index < header.chunkCount; index++) {
    const frame = await receive();
    const size = Math.min(chunkLimit, bytes.byteLength - index * chunkLimit);
    if (
      !keys(frame, ["schemaVersion", "kind", "index", "hex"]) ||
      frame.schemaVersion !== 1 ||
      frame.kind !== "recovery-chunk" ||
      frame.index !== index ||
      typeof frame.hex !== "string" ||
      frame.hex.length !== size * 2 ||
      !/^[0-9a-f]+$/u.test(frame.hex)
    )
      throw new TypeError("Invalid publication recovery chunk");
    Buffer.from(frame.hex, "hex").copy(bytes, index * chunkLimit);
  }
  const complete = await receive();
  if (
    !keys(complete, ["schemaVersion", "kind"]) ||
    complete.schemaVersion !== 1 ||
    complete.kind !== "recovery-complete" ||
    createHash("sha256").update(bytes).digest("hex") !== header.sha256
  )
    throw new TypeError("Unconfirmed publication recovery record");
  const recoveryPaths = Object.freeze([
    ...(header.stage === null ? [] : [join(parentPath, stageName)]),
    join(parentPath, journalName),
    ...(header.update === null ? [] : [join(parentPath, updateName)]),
  ]);
  return Object.freeze({
    ...recognizeJournal(bytes, header.parent, header.nameMax, parentPath),
    recoveryPaths,
  });
}

function recognizeJournal(
  bytes: Uint8Array,
  parent: Identity,
  nameMax: number,
  parentPath: string
): Omit<MetalPublicationRecoveryReport, "recoveryPaths"> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    const prepared =
      value !== null &&
      typeof value === "object" &&
      "phase" in value &&
      value.phase === "prepared";
    const intent =
      value !== null &&
      typeof value === "object" &&
      "phase" in value &&
      value.phase === "intent";
    const publicationVariant =
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "publication");
    if (
      !keys(value, [
        "schemaVersion",
        "kind",
        "phase",
        "transactionId",
        "parent",
        "destinationName",
        "moduleName",
        ...(intent ? [] : ["stage"]),
        ...(prepared ? ["recordSHA256", "files"] : []),
        ...(publicationVariant ? ["publication"] : []),
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== "vgpu-native-publication" ||
      (value.phase !== "intent" &&
        value.phase !== "staging" &&
        value.phase !== "prepared") ||
      typeof value.transactionId !== "string" ||
      !/^[0-9a-f]{32}$/u.test(value.transactionId) ||
      !identity(value.parent) ||
      value.parent.device !== parent.device ||
      value.parent.inode !== parent.inode ||
      !component(value.destinationName, nameMax) ||
      [journalName, stageName, updateName].includes(value.destinationName) ||
      !component(value.moduleName, nameMax)
    )
      return undefined;
    validateSwiftIdentifier(value.moduleName, "moduleName");
    if (
      prepared &&
      !preparedFiles(value.files, value.moduleName, value.recordSHA256)
    )
      return undefined;
    let stage: InterruptedMetalPublication["stage"];
    if (!intent) {
      if (
        !keys(value.stage, ["name", "device", "inode"]) ||
        value.stage.name !== stageName ||
        !decimal(value.stage.device) ||
        !decimal(value.stage.inode)
      )
        return undefined;
      stage = Object.freeze({
        name: stageName,
        device: value.stage.device,
        inode: value.stage.inode,
      });
    }
    const publication = publicationVariant
      ? parseMetalPublicationPlan(value.publication, parent, stage)
      : undefined;
    if (publicationVariant && !publication) return undefined;
    const transaction: InterruptedMetalPublication = Object.freeze({
      transactionId: value.transactionId,
      phase: value.phase,
      parent: Object.freeze({ ...parent }),
      destinationName: value.destinationName,
      outputPath: join(parentPath, value.destinationName),
      moduleName: value.moduleName,
      ...(stage ? { stage } : {}),
      ...(publication ? { publication } : {}),
    });
    return Object.freeze({
      transaction,
      ...(prepared
        ? {
            prepared: Object.freeze({
              recordSHA256: value.recordSHA256 as string,
              files: Object.freeze(
                (
                  value.files as NonNullable<
                    MetalPublicationRecoveryReport["prepared"]
                  >["files"]
                ).map((file) => Object.freeze({ ...file }))
              ),
            }),
          }
        : {}),
    });
  } catch {
    return undefined;
  }
}

function preparedFiles(
  files: unknown,
  moduleName: string,
  recordSHA256: unknown
): boolean {
  if (!Array.isArray(files) || files.length !== 4 || !digest(recordSHA256))
    return false;
  const expected = [
    ["package-manifest", "Package.swift"],
    ["swift-source", `Sources/${moduleName}/Shaders.generated.swift`],
    ["metal-library", `Sources/${moduleName}/Resources/Shaders.metallib`],
    ["output-record", ".vgpu-native-output.json"],
  ];
  let aggregate = 0;
  for (const [index, [role, path]] of expected.entries()) {
    const file: unknown = files[index];
    if (
      !keys(file, ["role", "path", "length", "sha256"]) ||
      file.role !== role ||
      file.path !== path ||
      !integer(file.length, 1, index === 3 ? recordLimit : 128 * 1024 * 1024) ||
      !digest(file.sha256)
    )
      return false;
    aggregate += file.length;
    if (
      aggregate > 128 * 1024 * 1024 ||
      (index === 3 && file.sha256 !== recordSHA256)
    )
      return false;
  }
  return true;
}

function keys(
  value: unknown,
  expected: readonly string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function decimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/u.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  );
}

function identity(value: unknown): value is Identity {
  return (
    keys(value, ["device", "inode"]) &&
    decimal(value.device) &&
    decimal(value.inode)
  );
}

function entry(value: unknown): value is ObservedEntry | null {
  return (
    value === null ||
    (keys(value, ["device", "inode", "kind"]) &&
      decimal(value.device) &&
      decimal(value.inode) &&
      typeof value.kind === "string" &&
      ["directory", "file", "symlink", "other"].includes(value.kind))
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

function component(value: unknown, nameMax: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\x00-\x1f\x7f/]/u.test(value) &&
    Buffer.byteLength(value) <= nameMax &&
    Buffer.from(value).toString("utf8") === value
  );
}
