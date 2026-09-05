import { VGPUError, compute, init, pingPongStorage } from "vgpu/node";

const ELEMENT_COUNT = 8;
const STATE_BYTES = ELEMENT_COUNT * Uint32Array.BYTES_PER_ELEMENT;
const AUDIT_BYTES = 4 * Uint32Array.BYTES_PER_ELEMENT;
const INITIAL = Uint32Array.from(
  { length: ELEMENT_COUNT },
  (_, index) => index
);
const EXPECTED_FINAL = Uint32Array.of(6, 14, 22, 30, 38, 46, 54, 62);
const EXPECTED_ADVANCE_AUDIT = Uint32Array.of(101, 2, 1, 2);
const EXPECTED_MIX_AUDIT = Uint32Array.of(202, 2, 2, 1);
const NEGATIVE_AUDIT_SENTINEL = Uint32Array.of(901, 902, 903, 904);

const shader = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read> mask: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> advanceAudit: array<u32>;
@group(0) @binding(4) var<storage, read_write> mixAudit: array<u32>;

@compute @workgroup_size(2, 1, 1)
fn advance(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(num_workgroups) groups: vec3<u32>,
) {
  let index = id.x + id.z * (groups.x * 2u);
  if (index >= arrayLength(&dst)) {
    return;
  }

  dst[index] = src[index] * 2u + (mask[index] - src[index]) + 1u;
  if (index == 0u) {
    advanceAudit[0] = 101u;
    advanceAudit[1] = groups.x;
    advanceAudit[2] = groups.y;
    advanceAudit[3] = groups.z;
  }
}

@compute @workgroup_size(1, 2, 1)
fn mix(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(num_workgroups) groups: vec3<u32>,
) {
  let index = id.y * groups.x + id.x;
  if (index >= arrayLength(&dst)) {
    return;
  }

  dst[index] = src[index] * 2u + mask[index] * 2u + 2u;
  if (index == 0u) {
    mixAudit[0] = 202u;
    mixAudit[1] = groups.x;
    mixAudit[2] = groups.y;
    mixAudit[3] = groups.z;
  }
}
`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function values(view: Uint32Array): number[] {
  return Array.from(view);
}

function equal(
  actual: Uint32Array,
  expected: Uint32Array,
  label: string
): void {
  assert(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${label}: expected ${JSON.stringify(
      values(expected)
    )}, received ${JSON.stringify(values(actual))}`
  );
}

async function readU32(buffer: {
  read(): Promise<ArrayBuffer>;
}): Promise<Uint32Array> {
  return new Uint32Array(await buffer.read());
}

async function main(): Promise<void> {
  const gpu = await init();
  const deliveredErrors: string[] = [];
  const stopListening = gpu.onError((error) =>
    deliveredErrors.push(error.code)
  );

  try {
    const state = pingPongStorage(gpu, STATE_BYTES);
    const audits = pingPongStorage(gpu, AUDIT_BYTES);
    const advanceAudit = audits.read;
    const mixAudit = audits.write;
    const halfA = state.read;
    const halfB = state.write;
    const roleStates: string[] = [];

    const recordRoles = (read: typeof halfA, write: typeof halfA): void => {
      if (read === halfA && write === halfB) roleStates.push("A->B");
      else if (read === halfB && write === halfA) roleStates.push("B->A");
      else
        throw new Error(
          "ping-pong roles no longer select two distinct, alternating halves"
        );
    };

    state.read.write(INITIAL);
    state.write.write(
      Uint32Array.from({ length: ELEMENT_COUNT }, () => 0xffff_ffff)
    );
    advanceAudit.write(Uint32Array.from({ length: 4 }, () => 0xffff_ffff));
    mixAudit.write(Uint32Array.from({ length: 4 }, () => 0xffff_ffff));

    const advance = compute(gpu, shader, {
      entry: "advance",
      label: "c4.advance",
    });
    const mix = compute(gpu, shader, { entry: "mix", label: "c4.mix" });

    recordRoles(state.read, state.write);
    advance.set({
      src: state.read,
      mask: state.read,
      dst: state.write,
      advanceAudit,
    });
    advance.dispatch(2, 1, 2);

    state.swap();
    recordRoles(state.read, state.write);
    mix.set({
      src: state.read,
      mask: state.read,
      dst: state.write,
      mixAudit,
    });
    mix.dispatch(2, 2, 1);

    state.swap();
    recordRoles(state.read, state.write);

    // These reads are the first await after both dispatches. Their copy commands therefore prove
    // that the second submission observes the first through the public vgpu queue ordering.
    const [finalState, positiveAdvanceAudit, positiveMixAudit] =
      await Promise.all([
        readU32(state.read),
        readU32(advanceAudit),
        readU32(mixAudit),
      ]);
    equal(finalState, EXPECTED_FINAL, "final state");
    equal(positiveAdvanceAudit, EXPECTED_ADVANCE_AUDIT, "advance audit");
    equal(positiveMixAudit, EXPECTED_MIX_AUDIT, "mix audit");

    // A distinct sentinel makes the negative observable without reaching into GPUDevice or
    // intercepting queue.submit(): a submitted kernel would change both state and this audit.
    advanceAudit.write(NEGATIVE_AUDIT_SENTINEL);
    const stateBeforeNegative = await readU32(state.read);
    let aliasingCode: string | undefined;
    let threwSynchronously = false;

    advance.set({
      src: state.read,
      mask: state.read,
      dst: state.read,
      advanceAudit,
    });
    try {
      advance.dispatch(2, 1, 2);
    } catch (error) {
      threwSynchronously = true;
      assert(
        error instanceof VGPUError,
        "aliasing preflight did not throw the public VGPUError type"
      );
      aliasingCode = error.code;
    }

    assert(
      threwSynchronously,
      "same-storage src/dst did not throw synchronously"
    );
    assert(
      aliasingCode === "VGPU-R1-STORAGE-ALIASING",
      `unexpected aliasing code: ${String(aliasingCode)}`
    );
    await gpu.settled();
    const [stateAfterNegative, auditAfterNegative] = await Promise.all([
      readU32(state.read),
      readU32(advanceAudit),
    ]);
    equal(
      stateAfterNegative,
      stateBeforeNegative,
      "state after rejected aliasing dispatch"
    );
    equal(
      auditAfterNegative,
      NEGATIVE_AUDIT_SENTINEL,
      "audit after rejected aliasing dispatch"
    );
    assert(
      deliveredErrors.length === 0,
      `rejected dispatch leaked to onError: ${JSON.stringify(deliveredErrors)}`
    );

    const report = {
      contract: "vgpu-native-c4-webgpu-oracle/v1",
      status: "passed",
      api: ["init", "compute", "pingPongStorage"],
      entries: [
        {
          name: "advance",
          activeBindings: [0, 1, 2, 3],
          workgroupSize: [2, 1, 1],
          dispatch: [2, 1, 2],
        },
        {
          name: "mix",
          activeBindings: [0, 1, 2, 4],
          workgroupSize: [1, 2, 1],
          dispatch: [2, 2, 1],
        },
      ],
      sequence: {
        roles: roleStates,
        explicitSets: ["advance:A->B", "mix:B->A"],
        submissionsBeforeFirstAwait: 2,
      },
      readbacks: {
        final: values(finalState),
        advanceAudit: values(positiveAdvanceAudit),
        mixAudit: values(positiveMixAudit),
      },
      aliasing: {
        code: aliasingCode,
        synchronous: threwSynchronously,
        stateUnchanged: true,
        auditUnchanged: true,
        onErrorCount: deliveredErrors.length,
      },
    };

    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    stopListening();
    gpu.dispose();
  }
}

await main();
