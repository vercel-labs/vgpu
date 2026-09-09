import { describe, expect, it } from "vitest";
import {
  assertAgentSurface,
  assertResolvedAgentSurface,
} from "../scripts/check-agent-surface.ts";
import {
  DISABLED_EVE_TOOLS,
  SECURITY_SUBAGENT_NAME,
} from "../src/constants.ts";

function emptyAgent(disabledFrameworkTools: readonly string[]) {
  return {
    tools: [],
    dynamicTools: [],
    dynamicSkills: [],
    dynamicInstructions: [],
    skills: [],
    connections: [],
    remoteAgents: [],
    channels: [],
    schedules: [],
    hooks: [],
    extensionMounts: [],
    workspaceResourceRoot: { rootEntries: [] },
    sandbox: null,
    sandboxWorkspaces: [],
    workflowTool: null,
    disabledFrameworkTools,
  };
}

function safeManifest(): Record<string, unknown> {
  const childNodeId = "subagents/issue_security_triager";
  return {
    ...emptyAgent(DISABLED_EVE_TOOLS),
    channels: [
      ["GET", "/eve/v1/info"],
      ["POST", "/eve/v1/session"],
      ["POST", "/eve/v1/session/reset"],
      ["POST", "/eve/v1/session/clear"],
      ["POST", "/eve/v1/session/compact"],
      ["POST", "/eve/v1/session/:sessionId"],
      ["POST", "/eve/v1/session/:sessionId/cancel"],
      ["GET", "/eve/v1/session/:sessionId/stream"],
    ].map(([method, urlPath]) => ({
      kind: "channel",
      name: "eve",
      logicalPath: "channels/eve.ts",
      method,
      urlPath,
      sourceId: "channels/eve.ts",
      sourceKind: "module",
      adapterKind: "http",
    })),
    subagents: [
      {
        name: SECURITY_SUBAGENT_NAME,
        nodeId: childNodeId,
        agent: emptyAgent(
          DISABLED_EVE_TOOLS.filter((tool) => tool !== "agent")
        ),
      },
    ],
    subagentEdges: [{ parentNodeId: "__root__", childNodeId }],
  };
}

function resolvedNode(toolNames: readonly string[]) {
  return {
    turnAgent: {
      tools: toolNames.map((name) => ({ name })),
    },
  };
}

function safeResolvedGraph(): Record<string, unknown> {
  const root = resolvedNode([SECURITY_SUBAGENT_NAME]);
  return {
    root,
    nodesByNodeId: new Map([
      ["__root__", root],
      [`subagents/${SECURITY_SUBAGENT_NAME}`, resolvedNode([])],
    ]),
  };
}

describe("assertAgentSurface", () => {
  it("accepts a root exposing only the tool-less security subagent", () => {
    expect(() => assertAgentSurface(safeManifest())).not.toThrow();
  });

  it("rejects authored or dynamic capabilities", () => {
    for (const [key, value] of [
      ["tools", [{ name: "danger" }]],
      ["dynamicTools", [{}]],
      ["dynamicSkills", [{}]],
      ["dynamicInstructions", [{}]],
      ["connections", [{}]],
      ["skills", [{}]],
      ["remoteAgents", [{}]],
      ["schedules", [{}]],
      ["hooks", [{}]],
      ["extensionMounts", [{}]],
      ["sandboxWorkspaces", [{}]],
      ["workflowTool", {}],
      ["sandbox", {}],
    ] as const) {
      const manifest = safeManifest();
      manifest[key] = value;
      expect(() => assertAgentSurface(manifest), key).toThrow("must be");
    }

    const workspaceResources = safeManifest();
    workspaceResources.workspaceResourceRoot = { rootEntries: [{}] };
    expect(() => assertAgentSurface(workspaceResources)).toThrow(
      "rootEntries must be empty"
    );
  });

  it("rejects a missing disable sentinel", () => {
    const manifest = safeManifest();
    manifest.disabledFrameworkTools = DISABLED_EVE_TOOLS.filter(
      (tool) => tool !== "load_skill"
    );
    expect(() => assertAgentSurface(manifest)).toThrow("expected");

    const childManifest = safeManifest();
    const child = (
      childManifest.subagents as Array<Record<string, unknown>>
    )[0]!;
    (child.agent as Record<string, unknown>).disabledFrameworkTools =
      DISABLED_EVE_TOOLS.filter(
        (tool) => tool !== "agent" && tool !== "load_skill"
      );
    expect(() => assertAgentSurface(childManifest)).toThrow("expected");
  });

  it("requires the exact authenticated Eve channel override", () => {
    const missing = safeManifest();
    missing.channels = [];
    expect(() => assertAgentSurface(missing)).toThrow("root Eve HTTP routes");

    for (const [key, value] of [
      ["name", "other"],
      ["kind", "disabled"],
      ["logicalPath", "channels/other.ts"],
      ["sourceId", "channels/other.ts"],
      ["sourceKind", "external"],
      ["adapterKind", "slack"],
      ["method", "PUT"],
      ["urlPath", "/unreviewed"],
      ["cors", {}],
    ]) {
      const manifest = safeManifest();
      (manifest.channels as Array<Record<string, unknown>>)[0]![key as string] =
        value;
      expect(() => assertAgentSurface(manifest), String(key)).toThrow(
        "Unsafe Eve agent surface"
      );
    }

    const extra = safeManifest();
    const routes = extra.channels as unknown[];
    routes.push(routes[0]);
    expect(() => assertAgentSurface(extra)).toThrow("root Eve HTTP routes");

    const childChannels = safeManifest();
    const child = (
      childChannels.subagents as Array<Record<string, unknown>>
    )[0]!;
    (child.agent as Record<string, unknown>).channels = childChannels.channels;
    expect(() => assertAgentSurface(childChannels)).toThrow(
      "issue_security_triager.channels must be empty"
    );
  });

  it("rejects extra or tool-enabled subagents", () => {
    const extra = safeManifest();
    (extra.subagents as unknown[]).push({
      name: "other",
      agent: emptyAgent([]),
    });
    expect(() => assertAgentSurface(extra)).toThrow("exactly one");

    const childTool = safeManifest();
    const child = (childTool.subagents as Array<Record<string, unknown>>)[0]!;
    (child.agent as Record<string, unknown>).tools = [{ name: "web_fetch" }];
    expect(() => assertAgentSurface(childTool)).toThrow("must be empty");
  });

  it("rejects an incorrect edge", () => {
    const incorrectParent = safeManifest();
    incorrectParent.subagentEdges = [
      {
        parentNodeId: "subagents/other",
        childNodeId: "subagents/issue_security_triager",
      },
    ];
    expect(() => assertAgentSurface(incorrectParent)).toThrow(
      "must originate at the root agent"
    );

    const incorrectChild = safeManifest();
    incorrectChild.subagentEdges = [
      { parentNodeId: "__root__", childNodeId: "other" },
    ];
    expect(() => assertAgentSurface(incorrectChild)).toThrow("does not target");
  });
});

describe("assertResolvedAgentSurface", () => {
  it("accepts the exact model-visible root and child toolsets", () => {
    expect(() => assertResolvedAgentSurface(safeResolvedGraph())).not.toThrow();
  });

  it("rejects a framework tool hidden from the authored manifest", () => {
    const rootLeak = safeResolvedGraph();
    (rootLeak.nodesByNodeId as Map<string, unknown>).set(
      "__root__",
      resolvedNode(["load_skill", SECURITY_SUBAGENT_NAME])
    );
    expect(() => assertResolvedAgentSurface(rootLeak)).toThrow(
      "root model-visible tools"
    );

    const childLeak = safeResolvedGraph();
    (childLeak.nodesByNodeId as Map<string, unknown>).set(
      `subagents/${SECURITY_SUBAGENT_NAME}`,
      resolvedNode(["load_skill"])
    );
    expect(() => assertResolvedAgentSurface(childLeak)).toThrow(
      `${SECURITY_SUBAGENT_NAME} model-visible tools`
    );
  });

  it("rejects unexpected resolved agent nodes", () => {
    const graph = safeResolvedGraph();
    (graph.nodesByNodeId as Map<string, unknown>).set(
      "subagents/unexpected",
      resolvedNode([])
    );
    expect(() => assertResolvedAgentSurface(graph)).toThrow(
      "resolved agent node IDs"
    );
  });
});
