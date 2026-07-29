import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, bundle, draw, effect, frame, target } from "../src/mock.ts";
import { visibility } from "../src/visibility.ts";

const SOLID = `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`;

test("visibility(gpu) needs no device feature and creates one occlusion query set of the declared capacity", async () => {
  const gpu = await init();
  expect(gpu.device.features.size).toBe(0);
  const vis = visibility(gpu, { capacity: 8 });

  const instrumentation = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(instrumentation.createQuerySetDescriptors).toEqual([
    { type: "occlusion", count: 8, label: "vgpu.visibility" },
  ]);
  vis.dispose();
  gpu.dispose();
});

test("a visibility pass carries the occlusion query set in its descriptor; other passes stay clean", async () => {
  const gpu = await init();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, visibility: vis }, () => undefined);
    currentFrame.pass(scene, () => undefined);
  });

  // Pass descriptor rule: occlusionQuerySet must be a valid query set of type "occlusion".
  const querySet = ops.passDescriptors[0]?.occlusionQuerySet;
  expect(querySet?.type).toBe("occlusion");
  expect(querySet?.count).toBe(64); // default capacity
  expect("occlusionQuerySet" in ops.passDescriptors[1]!).toBe(false);
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("occlusion() wraps single-draw, callback, and effect bodies with contiguous indices in allocation order", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const proxy = draw(gpu, { shader: SOLID, label: "proxy" });
  const shader1 = effect(gpu, SOLID);
  const qA = vis.query("a");
  const qB = vis.query("b");
  const qC = vis.query("c");

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, visibility: vis }, (p) => {
      p.draw(proxy); // outside any scope: does not count toward a query
      p.occlusion(qA, proxy);
      p.occlusion(qB, () => {
        p.draw(proxy);
        p.draw(proxy);
      });
      p.occlusion(qC, shader1);
    });
  });

  // Slot order = allocation order, contiguous from 0, and every begin is closed by an end.
  expect(getMockGPUDeviceInstrumentation(gpu.device.gpu).occlusionQueryOps).toEqual([
    ["begin", 0], ["end"],
    ["begin", 1], ["end"],
    ["begin", 2], ["end"],
  ]);
  vis.dispose();
  gpu.dispose();
});

test("one resolve of the contiguous used range is appended before finish", async () => {
  const gpu = await init();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const qA = vis.query("a");
  const qB = vis.query("b");

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, visibility: vis }, (p) => {
      p.occlusion(qA, () => undefined);
      p.occlusion(qB, () => undefined);
    });
  });

  expect(ops.encodeOps).toEqual([
    ["resolveQuerySet", 0, 2],
    ["copyBufferToBuffer", 2 * 8],
    ["finish"],
  ]);
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("results decode zero vs non-zero only: slot 0 confirms hidden, other slots visible, unused stays unknown", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const qHidden = vis.query("statue");
  const qVisible = vis.query("tower");
  const qUnused = vis.query("bird");

  expect([qHidden.state, qVisible.state, qUnused.state]).toEqual(["unknown", "unknown", "unknown"]);
  expect([qHidden.hidden, qVisible.hidden, qUnused.hidden]).toEqual([false, false, false]);

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, visibility: vis }, (p) => {
      p.occlusion(qHidden, () => undefined); // slot 0 — mock fake value 0 (confirmed zero samples)
      p.occlusion(qVisible, () => undefined); // slot 1 — mock fake value 1e6 (non-zero)
    });
    // Latch contract: results never land inside a frame callback.
    expect([qHidden.state, qVisible.state]).toEqual(["unknown", "unknown"]);
  });
  await gpu.settled();

  expect(qHidden.state).toBe("hidden");
  expect(qHidden.hidden).toBe(true);
  expect(qVisible.state).toBe("visible");
  expect(qVisible.hidden).toBe(false); // hidden is true ONLY on confirmed zero
  expect(qUnused.state).toBe("unknown");
  expect(qUnused.hidden).toBe(false);
  vis.dispose();
  gpu.dispose();
});

test("re-allocation order changes slots per frame, and newer results overwrite older ones", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const qA = vis.query("a");
  const qB = vis.query("b");

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(qA, () => undefined);
    p.occlusion(qB, () => undefined);
  }));
  await gpu.settled();
  expect([qA.state, qB.state]).toEqual(["hidden", "visible"]);

  // Allocation resets each frame: swapping call order swaps the slots and the decoded results.
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(qB, () => undefined);
    p.occlusion(qA, () => undefined);
  }));
  await gpu.settled();
  expect([qA.state, qB.state]).toEqual(["visible", "hidden"]);
  vis.dispose();
  gpu.dispose();
});

test("allocation is contiguous across passes of one frame and resets on the next frame", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const sceneA = target(gpu, { size: [4, 4], depth: true });
  const sceneB = target(gpu, { size: [4, 4], depth: true });
  const qA = vis.query("a");
  const qB = vis.query("b");
  const instrumentation = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: sceneA, visibility: vis }, (p) => p.occlusion(qA, () => undefined));
    currentFrame.pass({ target: sceneB, visibility: vis }, (p) => p.occlusion(qB, () => undefined));
  });
  expect(instrumentation.occlusionQueryOps).toEqual([["begin", 0], ["end"], ["begin", 1], ["end"]]);

  instrumentation.occlusionQueryOps.length = 0;
  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: sceneA, visibility: vis }, (p) => p.occlusion(qB, () => undefined));
  });
  expect(instrumentation.occlusionQueryOps).toEqual([["begin", 0], ["end"]]);
  vis.dispose();
  gpu.dispose();
});

test("age is Infinity before any result, 0 when a result lands, and advances with the frame counter", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const q = vis.query("statue");

  expect(q.age).toBe(Infinity);
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();
  expect(q.age).toBe(0);

  frame(gpu, (currentFrame) => currentFrame.pass(scene, () => undefined)); // frame without the query
  expect(q.age).toBe(1);
  frame(gpu, (currentFrame) => currentFrame.pass(scene, () => undefined));
  expect(q.age).toBe(2);

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();
  expect(q.age).toBe(0);
  vis.dispose();
  gpu.dispose();
});

test("reset() flips state to unknown immediately and discards in-flight pre-reset readbacks", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const q = vis.query("statue");

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  // Reset before the readback applies: the pre-reset frame's result must NOT resurrect.
  q.reset();
  expect(q.state).toBe("unknown");
  await gpu.settled();
  expect(q.state).toBe("unknown");
  expect(q.hidden).toBe(false);
  expect(q.age).toBe(Infinity);

  // A post-reset frame applies normally again.
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();
  expect(q.state).toBe("hidden");

  // An applied result also resets to unknown (camera cut semantics).
  q.reset();
  expect(q.state).toBe("unknown");
  expect(q.age).toBe(Infinity);
  vis.dispose();
  gpu.dispose();
});

test("Visibility.reset() resets every live handle", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const qA = vis.query("a");
  const qB = vis.query("b");

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(qA, () => undefined);
    p.occlusion(qB, () => undefined);
  }));
  await gpu.settled();
  expect([qA.state, qB.state]).toEqual(["hidden", "visible"]);

  vis.reset();
  expect([qA.state, qB.state]).toEqual(["unknown", "unknown"]);
  vis.dispose();
  gpu.dispose();
});

test("bundles executed inside an occlusion scope encode between begin and end (their draws count toward the query)", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const drawable = draw(gpu, { shader: SOLID, label: "bundled" });
  const recorded = bundle(gpu, { target: scene, label: "proxyBundle" }, (b) => b.draw(drawable));
  const q = vis.query("statue");
  const ops: string[] = [];
  spyExecuteBundlesAndOcclusion(gpu.device.gpu, ops);

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(q, () => p.bundles(recorded));
  }));

  expect(ops).toEqual(["beginOcclusionQuery:0", "executeBundles", "endOcclusionQuery"]);
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a depthReadOnly pass supports visibility and occlusion scopes", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const proxy = draw(gpu, { shader: SOLID, label: "roProxy", depth: { write: false } });
  const q = vis.query("statue");

  frame(gpu, (currentFrame) => {
    currentFrame.pass(scene, () => undefined); // lay down depth
    currentFrame.pass({ target: scene, clear: false, depthReadOnly: true, visibility: vis }, (p) => {
      p.occlusion(q, proxy);
    });
  });
  await gpu.settled();

  expect(getMockGPUDeviceInstrumentation(gpu.device.gpu).occlusionQueryOps).toEqual([["begin", 0], ["end"]]);
  expect(q.state).toBe("hidden"); // slot 0 decodes to confirmed zero
  vis.dispose();
  gpu.dispose();
});

test("an MSAA depth target works with visibility", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true, msaa: true });
  const q = vis.query("statue");

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();
  expect(q.state).toBe("hidden");
  vis.dispose();
  gpu.dispose();
});

test("VGPU-VIS-CAPACITY-LIMIT rejects non-integer, < 1, and > 4096 capacities at visibility(gpu)", async () => {
  const gpu = await init();
  for (const capacity of [0, -1, 1.5, 4097, Number.NaN]) {
    expect(() => visibility(gpu, { capacity })).toThrowError(/VGPU-VIS-CAPACITY-LIMIT|expected an integer in \[1, 4096\]/);
  }
  expect(() => visibility(gpu, { capacity: 4096 }).dispose()).not.toThrow();
  gpu.dispose();
});

test("VGPU-VIS-CAPACITY throws at the occlusion() call that overflows the declared capacity", async () => {
  const gpu = await init();
  const vis = visibility(gpu, { capacity: 2 });
  const scene = target(gpu, { size: [4, 4], depth: true });
  const queries = [vis.query("a"), vis.query("b"), vis.query("c")];

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    expect(() => p.occlusion(queries[0]!, () => undefined)).not.toThrow();
    expect(() => p.occlusion(queries[1]!, () => undefined)).not.toThrow();
    p.occlusion(queries[2]!, () => undefined); // the call that overflows throws
  }))).toThrowError(/VGPU-VIS-CAPACITY|more than the declared 2/);

  // Capacity is per frame: the same instance encodes fine again next frame.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(queries[0]!, () => undefined);
    p.occlusion(queries[1]!, () => undefined);
  }))).not.toThrow();
  vis.dispose();
  gpu.dispose();
});

test("VGPU-VIS-LABEL-DUPLICATE rejects a live label; dispose() frees it for reuse", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const q = vis.query("statue");

  expect(() => vis.query("statue")).toThrowError(/VGPU-VIS-LABEL-DUPLICATE|already live/);
  q.dispose();
  expect(() => vis.query("statue")).not.toThrow();
  vis.dispose();
  gpu.dispose();
});

test("a disposed handle's in-flight readback is skipped, and a new same-label handle never receives it", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const q = vis.query("statue");

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  q.dispose(); // before the readback applies
  const reborn = vis.query("statue"); // label freed immediately — safe: results route by handle object, not label
  await gpu.settled();

  expect(q.state).toBe("unknown");
  expect(q.hidden).toBe(false);
  expect(reborn.state).toBe("unknown");
  expect(reborn.age).toBe(Infinity);
  vis.dispose();
  gpu.dispose();
});

test("VGPU-VIS-DISPOSED covers disposed handles and disposed visibility instances", async () => {
  const gpu = await init();
  const scene = target(gpu, { size: [4, 4], depth: true });
  const vis = visibility(gpu);
  const q = vis.query("statue");
  q.dispose();
  expect(() => q.reset()).toThrowError(/VGPU-VIS-DISPOSED|disposed/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)))).toThrowError(/VGPU-VIS-DISPOSED|disposed/);
  expect(() => q.dispose()).not.toThrow(); // idempotent

  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const vis2 = visibility(gpu);
  const q2 = vis2.query("tower");
  vis2.dispose();
  expect(destroyed).toEqual([0]);
  expect(() => vis2.query("x")).toThrowError(/VGPU-VIS-DISPOSED|disposed/);
  expect(() => vis2.reset()).toThrowError(/VGPU-VIS-DISPOSED|disposed/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis2 }, (p) => p.occlusion(q2, () => undefined)))).toThrowError(/VGPU-VIS-DISPOSED|disposed/);
  expect(() => vis2.dispose()).not.toThrow();
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("VGPU-VIS-NO-DEPTH rejects visibility on a pass whose target has no depth attachment", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const flat = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: flat, visibility: vis }, () => undefined)))
    .toThrowError(/VGPU-VIS-NO-DEPTH|no depth attachment/);
  vis.dispose();
  gpu.dispose();
});

test("VGPU-QUERY-NO-VISIBILITY rejects occlusion() in a pass opened without visibility", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const q = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(scene, (p) => p.occlusion(q, () => undefined))))
    .toThrowError(/VGPU-QUERY-NO-VISIBILITY|no occlusionQuerySet/);
  vis.dispose();
  gpu.dispose();
});

test("VGPU-QUERY-NESTED rejects occlusion() inside an active occlusion() body", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const qA = vis.query("a");
  const qB = vis.query("b");

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(qA, () => p.occlusion(qB, () => undefined));
  }))).toThrowError(/VGPU-QUERY-NESTED|cannot nest/);

  // The throwing scope still closed its query: sequential scopes keep working in a later frame.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(qA, () => undefined);
    p.occlusion(qB, () => undefined);
  }))).not.toThrow();
  vis.dispose();
  gpu.dispose();
});

test("VGPU-QUERY-DUPLICATE rejects reusing a handle within one frame, across passes too", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const q = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(q, () => undefined);
    p.occlusion(q, () => undefined);
  }))).toThrowError(/VGPU-QUERY-DUPLICATE|already used this frame/);

  // Cross-pass reuse silently overwrites the earlier result in native WebGPU; vgpu forbids it.
  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined));
    currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined));
  })).toThrowError(/VGPU-QUERY-DUPLICATE|already used this frame/);

  // The same handle is fine again on the next frame.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)))).not.toThrow();
  vis.dispose();
  gpu.dispose();
});

test("mismatched instances are rejected: foreign handles, foreign gpus, and non-visibility values", async () => {
  const gpuA = await init();
  const gpuB = await init();
  const visA = visibility(gpuA);
  const visA2 = visibility(gpuA);
  const sceneA = target(gpuA, { size: [4, 4], depth: true });
  const sceneB = target(gpuB, { size: [4, 4], depth: true });
  const foreign = visA2.query("statue");

  // Handle from another Visibility instance.
  expect(() => frame(gpuA, (currentFrame) => currentFrame.pass({ target: sceneA, visibility: visA }, (p) => p.occlusion(foreign, () => undefined))))
    .toThrowError(/VGPU-VIS-INVALID|different visibility instance/);
  // Visibility from another gpu.
  expect(() => frame(gpuB, (currentFrame) => currentFrame.pass({ target: sceneB, visibility: visA }, () => undefined)))
    .toThrowError(/VGPU-VIS-INVALID|different gpu/);
  // Non-Visibility pass option and non-handle occlusion argument.
  expect(() => frame(gpuA, (currentFrame) => currentFrame.pass({ target: sceneA, visibility: {} as never }, () => undefined)))
    .toThrowError(/VGPU-VIS-INVALID|expected a Visibility/);
  expect(() => frame(gpuA, (currentFrame) => currentFrame.pass({ target: sceneA, visibility: visA }, (p) => p.occlusion({ label: "statue" } as never, () => undefined))))
    .toThrowError(/VGPU-VIS-INVALID|expected a VisibilityQuery/);

  visA.dispose();
  visA2.dispose();
  gpuA.dispose();
  gpuB.dispose();
});

test("invalid query labels fail at query()", async () => {
  const gpu = await init();
  const vis = visibility(gpu);
  for (const label of ["", 1, null, undefined, {}]) {
    expect(() => vis.query(label as never)).toThrowError(/VGPU-VIS-INVALID|non-empty string/);
  }
  vis.dispose();
  gpu.dispose();
});

test("canonical usage: stable handles created once, proxies always drawn, real draws conditioned on q.hidden", async () => {
  const gpu = await init();
  const scene = target(gpu, { size: [8, 8], depth: true });
  const world = effect(gpu, SOLID);
  const statue = draw(gpu, { shader: SOLID, label: "statue" });
  const statueProxy = draw(gpu, { shader: SOLID, label: "statueProxy" });
  const towerProxy = draw(gpu, { shader: SOLID, label: "towerProxy" });

  const vis = visibility(gpu, { capacity: 8 });
  const qStatue = vis.query("statue");
  const qTower = vis.query("tower");

  const statueDrawnPerFrame: boolean[] = [];
  const encodeFrame = () => frame(gpu, (f) => {
    f.pass({ target: scene, visibility: vis }, (p) => {
      p.draw(world);
      p.occlusion(qStatue, statueProxy);
      p.occlusion(qTower, () => p.draw(towerProxy));
      if (!qStatue.hidden) p.draw(statue);
      statueDrawnPerFrame.push(!qStatue.hidden);
    });
  });

  encodeFrame(); // frame 1: unknown -> safe default is to draw
  await gpu.settled();
  encodeFrame(); // frame 2: statue slot decoded to confirmed zero -> culled
  await gpu.settled();

  expect(qStatue.state).toBe("hidden");
  expect(qTower.state).toBe("visible");
  expect(statueDrawnPerFrame).toEqual([true, false]);
  vis.dispose();
  gpu.dispose();
});

test("dispose() mid-frame keeps the occlusion query set alive until the frame is submitted", async () => {
  const gpu = await init();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const vis = visibility(gpu, { capacity: 4 });
  const q = vis.query("statue");
  const scene = target(gpu, { size: [4, 4], depth: true });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined));
    // The pass descriptor's occlusionQuerySet already points at this set: destroying it mid-frame
    // would invalidate the frame being encoded, so destruction is deferred.
    vis.dispose();
    expect(destroyed).toEqual([]);
  });

  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a readback that fails is reported on gpu.onError and leaves handles untouched", async () => {
  const gpu = await init();
  const originalCreateBuffer = gpu.device.gpu.createBuffer.bind(gpu.device.gpu);
  vi.spyOn(gpu.device.gpu, "createBuffer").mockImplementation((descriptor: GPUBufferDescriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    if (descriptor.label?.includes("staging")) {
      (buffer as { mapAsync: GPUBuffer["mapAsync"] }).mapAsync = () => Promise.reject(new Error("device lost"));
    }
    return buffer;
  });
  const errors: Array<{ code: string; message: string }> = [];
  gpu.onError((error) => { errors.push(error); });
  const vis = visibility(gpu);
  const q = vis.query("statue");
  const scene = target(gpu, { size: [4, 4], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();

  // Dropped readback: no state change (never a silent "hidden"), but not swallowed either.
  expect(q.state).toBe("unknown");
  expect(q.hidden).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "VGPU-QUERY-READBACK", message: expect.stringContaining("vgpu.visibility") });
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("gpu.dispose() releases visibility instances created by that gpu", async () => {
  const gpu = await init();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const vis = visibility(gpu);
  const q = vis.query("statue");
  const scene = target(gpu, { size: [4, 4], depth: true });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();

  gpu.dispose();
  expect(destroyed).toEqual([0]);
  expect(() => vis.query("tower")).toThrowError(/VGPU-VIS-DISPOSED|disposed/);
  expect(() => vis.dispose()).not.toThrow();
  vi.restoreAllMocks();
});

test("two frames open at once each retain the query set; the newest frame's results still apply", async () => {
  const gpu = await init();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const vis = visibility(gpu, { capacity: 4 });
  const statue = vis.query("statue");
  const scene = target(gpu, { size: [4, 4], depth: true });

  const first = frame(gpu);
  first.pass({ target: scene, visibility: vis }, (p) => p.occlusion(statue, () => undefined));
  const second = frame(gpu);
  second.pass({ target: scene, visibility: vis }, (p) => p.occlusion(statue, () => undefined));

  // Submitting the older frame first must not release the newer frame's retain, and it reads nothing
  // back: the current frame identity is `second`, so the stale frame's results are discarded.
  first.submit();
  second.submit();
  await gpu.settled();
  // The newest frame's readback applied (the mock resolves query index 0 as 0 samples), so the handle
  // moved off "unknown" — one frame's results, not two, and no lost readback.
  expect(statue.state).toBe("hidden");

  vis.dispose();
  expect(destroyed).toEqual([0]);
  gpu.dispose();
  vi.restoreAllMocks();
});

type EncodeOp = readonly [name: string, ...args: unknown[]];

interface FrameEncoderOps {
  readonly passDescriptors: GPURenderPassDescriptor[];
  readonly encodeOps: EncodeOp[];
}

/** Captures render pass descriptors plus resolve/copy/finish ordering on vgpu.frame encoders. */
function spyFrameEncoders(device: GPUDevice): FrameEncoderOps {
  const passDescriptors: GPURenderPassDescriptor[] = [];
  const encodeOps: EncodeOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    if (descriptor?.label !== "vgpu.frame") return encoder;
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        passDescriptors.push(renderPassDescriptor);
        return encoder.beginRenderPass(renderPassDescriptor);
      },
      resolveQuerySet(querySet: GPUQuerySet, firstQuery: number, queryCount: number, destination: GPUBuffer, destinationOffset: number) {
        encodeOps.push(["resolveQuerySet", firstQuery, queryCount]);
        encoder.resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset);
      },
      copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size?: number) {
        encodeOps.push(["copyBufferToBuffer", size]);
        encoder.copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size);
      },
      finish(finishDescriptor?: GPUCommandBufferDescriptor) {
        encodeOps.push(["finish"]);
        return encoder.finish(finishDescriptor);
      },
    } as GPUCommandEncoder;
  });
  return { passDescriptors, encodeOps };
}

/** Orders executeBundles relative to the occlusion scope on vgpu.frame render passes. */
function spyExecuteBundlesAndOcclusion(device: GPUDevice, ops: string[]): void {
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    if (descriptor?.label !== "vgpu.frame") return encoder;
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = encoder.beginRenderPass(renderPassDescriptor);
        return {
          ...pass,
          beginOcclusionQuery(queryIndex: number) { ops.push(`beginOcclusionQuery:${queryIndex}`); pass.beginOcclusionQuery(queryIndex); },
          endOcclusionQuery() { ops.push("endOcclusionQuery"); pass.endOcclusionQuery(); },
          executeBundles(bundles: Iterable<GPURenderBundle>) { ops.push("executeBundles"); pass.executeBundles(bundles); },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
}

/** Records the creation index of each destroyed query set. */
function spyQuerySetDestroys(device: GPUDevice, destroyed: number[]): void {
  let created = 0;
  const originalCreateQuerySet = device.createQuerySet.bind(device);
  vi.spyOn(device, "createQuerySet").mockImplementation((descriptor: GPUQuerySetDescriptor) => {
    const querySet = originalCreateQuerySet(descriptor);
    const index = created++;
    const originalDestroy = querySet.destroy.bind(querySet);
    querySet.destroy = () => { destroyed.push(index); originalDestroy(); };
    return querySet;
  });
}

// --- gpu-first factory (T202-03) --------------------------------------------------------------

test("visibility(gpu) declares its capacity, latches results and ages through the kernel's frame clock", async () => {
  const gpu = await init();
  const vis = visibility(gpu, { capacity: 8 });
  const scene = target(gpu, { size: [4, 4], depth: true });
  const q = vis.query("statue");

  expect(getMockGPUDeviceInstrumentation(gpu.device.gpu).createQuerySetDescriptors).toEqual([
    { type: "occlusion", count: 8, label: "vgpu.visibility" },
  ]);
  expect(q.age).toBe(Infinity);

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => p.occlusion(q, () => undefined)));
  await gpu.settled();
  // The mock resolves occlusion queries to 0 samples, so the latch confirms "hidden" — the point
  // here is that a result landed at all: the handle left "unknown" and stamped the current frame.
  expect(q.state).toBe("hidden");
  expect(q.hidden).toBe(true);
  expect(q.age).toBe(0);

  // The clock the age reads is the kernel's frame state, the same one the frame runner advances.
  frame(gpu, (currentFrame) => currentFrame.pass(scene, () => undefined));
  expect(q.age).toBe(1);
  gpu.dispose();
});

test("a visibility(gpu) left open goes down with the gpu, and disposing it first drops its registration", async () => {
  const gpu = await init();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const owned = visibility(gpu);
  const released = visibility(gpu);

  released.dispose();
  expect(destroyed).toEqual([1]);

  gpu.dispose();
  expect([...destroyed].sort()).toEqual([0, 1]);
  expect(() => owned.dispose()).not.toThrow();
  vi.restoreAllMocks();
});

test("visibility(gpu) validates the gpu before touching the device", async () => {
  const gpu = await init();
  gpu.dispose();
  expect(thrownBy(() => visibility(gpu))).toMatchObject({ code: "VGPU-GPU-DISPOSED", where: "visibility" });
  expect(thrownBy(() => visibility({ disposed: false } as never))).toMatchObject({ code: "VGPU-GPU-FOREIGN" });
});

test("visibility(gpu) still rejects a capacity outside the WebGPU query-set limit", async () => {
  const gpu = await init();
  expect(thrownBy(() => visibility(gpu, { capacity: 4097 }))).toMatchObject({ code: "VGPU-VIS-CAPACITY-LIMIT" });
  expect(thrownBy(() => visibility(gpu, { capacity: 0 }))).toMatchObject({ code: "VGPU-VIS-CAPACITY-LIMIT" });
  gpu.dispose();
});

/** Returns what `run` threw, so an assertion can inspect the VGPUError's code instead of its message. */
function thrownBy(run: () => unknown): unknown {
  try { run(); }
  catch (error) { return error; }
  throw new Error("expected the call to throw");
}
