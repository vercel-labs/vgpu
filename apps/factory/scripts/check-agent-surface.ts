#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DISABLED_EVE_TOOLS,
  SECURITY_SUBAGENT_NAME,
} from "../src/constants.ts";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_MANIFEST = resolve(
  APP_ROOT,
  ".eve/compile/compiled-agent-manifest.json"
);
const CHILD_DISABLED_TOOLS = DISABLED_EVE_TOOLS.filter(
  (tool) => tool !== "agent"
);
const ROOT_AGENT_NODE_ID = "__root__";
const SECURITY_SUBAGENT_NODE_ID = `subagents/${SECURITY_SUBAGENT_NAME}`;
const EVE_HTTP_ROUTES = [
  "GET /eve/v1/info",
  "POST /eve/v1/session",
  "POST /eve/v1/session/reset",
  "POST /eve/v1/session/clear",
  "POST /eve/v1/session/compact",
  "POST /eve/v1/session/:sessionId",
  "POST /eve/v1/session/:sessionId/cancel",
  "GET /eve/v1/session/:sessionId/stream",
] as const;

interface ResolvedRuntimeAgentGraph {
  readonly nodesByNodeId: ReadonlyMap<string, unknown>;
}

interface EveRuntimeGraphModule {
  resolveRuntimeAgentGraph(input: {
    manifest: unknown;
    moduleMap: unknown;
  }): Promise<ResolvedRuntimeAgentGraph>;
}

function fail(message: string): never {
  throw new Error(`Unsafe Eve agent surface: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${name} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${name} is not an array.`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  const values = array(value, name);
  if (!values.every((entry) => typeof entry === "string")) {
    fail(`${name} contains a non-string entry.`);
  }
  return values as string[];
}

function assertExactStrings(
  actual: readonly string[],
  expected: readonly string[],
  name: string
): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    fail(
      `${name} was ${JSON.stringify(sortedActual)}; expected ${JSON.stringify(
        sortedExpected
      )}.`
    );
  }
}

function assertEmptyCapabilities(
  agent: Record<string, unknown>,
  name: string
): void {
  for (const key of [
    "tools",
    "dynamicTools",
    "dynamicSkills",
    "dynamicInstructions",
    "skills",
    "connections",
    "remoteAgents",
    "schedules",
    "hooks",
    "sandboxWorkspaces",
  ] as const) {
    if (array(agent[key], `${name}.${key}`).length !== 0) {
      fail(`${name}.${key} must be empty.`);
    }
  }
  if (agent.workflowTool !== undefined && agent.workflowTool !== null) {
    fail(`${name}.workflowTool must be absent.`);
  }
  if (agent.sandbox !== undefined && agent.sandbox !== null) {
    fail(`${name}.sandbox must be absent.`);
  }

  if (agent.extensionMounts !== undefined && agent.extensionMounts !== null) {
    if (array(agent.extensionMounts, `${name}.extensionMounts`).length !== 0) {
      fail(`${name}.extensionMounts must be empty.`);
    }
  }

  if (
    agent.workspaceResourceRoot !== undefined &&
    agent.workspaceResourceRoot !== null
  ) {
    const workspaceResourceRoot = record(
      agent.workspaceResourceRoot,
      `${name}.workspaceResourceRoot`
    );
    if (
      array(
        workspaceResourceRoot.rootEntries,
        `${name}.workspaceResourceRoot.rootEntries`
      ).length !== 0
    ) {
      fail(`${name}.workspaceResourceRoot.rootEntries must be empty.`);
    }
  }
}

function assertRootChannels(value: unknown): void {
  const routes = array(value, "root.channels").map((value, index) => {
    const name = `root.channels[${index}]`;
    const channel = record(value, name);
    assertExactStrings(
      Object.keys(channel),
      [
        "kind",
        "name",
        "logicalPath",
        "method",
        "urlPath",
        "sourceId",
        "sourceKind",
        "adapterKind",
      ],
      `${name} fields`
    );
    if (
      channel.kind !== "channel" ||
      channel.name !== "eve" ||
      channel.logicalPath !== "channels/eve.ts" ||
      channel.sourceId !== "channels/eve.ts" ||
      channel.sourceKind !== "module" ||
      channel.adapterKind !== "http"
    ) {
      fail(`${name} must be the authored Eve HTTP channel.`);
    }
    return `${String(channel.method)} ${String(channel.urlPath)}`;
  });
  // Pin all eight authenticated routes. An absent override silently restores
  // Eve's implicit localDev channel, and any added channel widens ingress.
  assertExactStrings(routes, EVE_HTTP_ROUTES, "root Eve HTTP routes");
}

export function assertAgentSurface(manifestValue: unknown): void {
  const manifest = record(manifestValue, "manifest");
  assertEmptyCapabilities(manifest, "root");
  assertRootChannels(manifest.channels);
  assertExactStrings(
    stringArray(manifest.disabledFrameworkTools, "root.disabledFrameworkTools"),
    DISABLED_EVE_TOOLS,
    "root.disabledFrameworkTools"
  );

  const subagents = array(manifest.subagents, "root.subagents");
  if (subagents.length !== 1) {
    fail(`root must expose exactly one subagent; found ${subagents.length}.`);
  }
  const subagent = record(subagents[0], "root.subagents[0]");
  if (subagent.name !== SECURITY_SUBAGENT_NAME) {
    fail(`unexpected subagent name ${JSON.stringify(subagent.name)}.`);
  }

  const childAgent = record(subagent.agent, `${SECURITY_SUBAGENT_NAME}.agent`);
  assertEmptyCapabilities(childAgent, SECURITY_SUBAGENT_NAME);
  if (
    array(childAgent.channels, `${SECURITY_SUBAGENT_NAME}.channels`).length !==
    0
  ) {
    fail(`${SECURITY_SUBAGENT_NAME}.channels must be empty.`);
  }
  assertExactStrings(
    stringArray(
      childAgent.disabledFrameworkTools,
      `${SECURITY_SUBAGENT_NAME}.disabledFrameworkTools`
    ),
    CHILD_DISABLED_TOOLS,
    `${SECURITY_SUBAGENT_NAME}.disabledFrameworkTools`
  );

  const edges = array(manifest.subagentEdges, "root.subagentEdges");
  if (edges.length !== 1) {
    fail(`root must have exactly one subagent edge; found ${edges.length}.`);
  }
  const edge = record(edges[0], "root.subagentEdges[0]");
  if (edge.parentNodeId !== ROOT_AGENT_NODE_ID) {
    fail("the sole subagent edge must originate at the root agent.");
  }
  if (edge.childNodeId !== subagent.nodeId) {
    fail("the sole subagent edge does not target issue_security_triager.");
  }
}

function resolvedToolNames(nodeValue: unknown, name: string): string[] {
  const node = record(nodeValue, name);
  const turnAgent = record(node.turnAgent, `${name}.turnAgent`);
  return array(turnAgent.tools, `${name}.turnAgent.tools`).map(
    (tool, index) => {
      const definition = record(tool, `${name}.turnAgent.tools[${index}]`);
      if (typeof definition.name !== "string") {
        fail(`${name}.turnAgent.tools[${index}].name is not a string.`);
      }
      return definition.name;
    }
  );
}

export function assertResolvedAgentSurface(graphValue: unknown): void {
  const graph = record(graphValue, "resolvedGraph");
  if (!(graph.nodesByNodeId instanceof Map)) {
    fail("resolvedGraph.nodesByNodeId is not a Map.");
  }

  const nodesByNodeId = graph.nodesByNodeId as ReadonlyMap<string, unknown>;
  assertExactStrings(
    [...nodesByNodeId.keys()],
    [ROOT_AGENT_NODE_ID, SECURITY_SUBAGENT_NODE_ID],
    "resolved agent node IDs"
  );
  assertExactStrings(
    resolvedToolNames(
      nodesByNodeId.get(ROOT_AGENT_NODE_ID),
      "root resolved agent"
    ),
    [SECURITY_SUBAGENT_NAME],
    "root model-visible tools"
  );
  assertExactStrings(
    resolvedToolNames(
      nodesByNodeId.get(SECURITY_SUBAGENT_NODE_ID),
      `${SECURITY_SUBAGENT_NAME} resolved agent`
    ),
    [],
    `${SECURITY_SUBAGENT_NAME} model-visible tools`
  );
}

async function resolveAgentGraph(
  manifestValue: unknown,
  manifestPath: string
): Promise<ResolvedRuntimeAgentGraph> {
  // Eve's compiled manifest lists authored tools and disable sentinels, but it
  // does not list the framework tools that are added during runtime graph
  // resolution. Import the pinned Eve runtime resolver so this check covers
  // the exact tool descriptors handed to its harness.
  const eveEntryUrl = import.meta.resolve("eve");
  const runtimeModuleUrl = new URL(
    "runtime/resolve-agent-graph.js",
    eveEntryUrl
  );
  const runtimeModule = (await import(
    runtimeModuleUrl.href
  )) as EveRuntimeGraphModule;
  if (typeof runtimeModule.resolveRuntimeAgentGraph !== "function") {
    fail(
      "the installed Eve package does not expose its runtime graph resolver."
    );
  }

  const moduleMapPath = resolve(dirname(manifestPath), "module-map.mjs");
  const moduleMapModule = (await import(pathToFileURL(moduleMapPath).href)) as {
    default?: unknown;
  };
  if (moduleMapModule.default === undefined) {
    fail(`${moduleMapPath} has no default export.`);
  }

  return runtimeModule.resolveRuntimeAgentGraph({
    manifest: manifestValue,
    moduleMap: moduleMapModule.default,
  });
}

async function main(): Promise<void> {
  const manifestPath =
    process.argv[2] === undefined
      ? DEFAULT_MANIFEST
      : resolve(process.cwd(), process.argv[2]);
  const source = await readFile(manifestPath, "utf8");
  const manifestValue = JSON.parse(source) as unknown;
  assertAgentSurface(manifestValue);
  assertResolvedAgentSurface(
    await resolveAgentGraph(manifestValue, manifestPath)
  );
  process.stdout.write(
    "Eve resolved model-visible tool surface is locked to issue_security_triager.\n"
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
