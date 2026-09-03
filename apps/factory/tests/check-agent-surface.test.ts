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
      ["channels", [{}]],
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
