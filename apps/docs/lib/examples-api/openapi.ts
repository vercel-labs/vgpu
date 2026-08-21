import discoverySchema from "./schemas/v1/discovery.schema.json";
import errorSchema from "./schemas/v1/error.schema.json";
import indexSchema from "./schemas/v1/index.schema.json";
import manifestSchema from "./schemas/v1/manifest.schema.json";
import { siteUrl } from "../site";

type JsonObject = Record<string, unknown>;

function rewriteLocalRefs(value: unknown, schemaName: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteLocalRefs(entry, schemaName));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "$ref" && typeof entry === "string" && entry.startsWith("#/$defs/")) {
      return [key, `#/components/schemas/${schemaName}/$defs/${entry.slice("#/$defs/".length)}`];
    }
    return [key, rewriteLocalRefs(entry, schemaName)];
  }));
}

function schemaVariant(variant: unknown, defs: unknown, schemaName: string): unknown {
  return rewriteLocalRefs({ ...(variant as JsonObject), $defs: defs }, schemaName);
}

const indexDocument = indexSchema as JsonObject;
const indexVariants = indexDocument.oneOf as unknown[];
const indexDefs = indexDocument.$defs;

const revisionParameter = {
  name: "revision",
  in: "path",
  required: true,
  description: "Immutable examples revision, encoded as a lowercase SHA-256 digest.",
  schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
} as const;

const exampleIdParameter = {
  name: "exampleId",
  in: "path",
  required: true,
  description: "Stable kebab-case example identifier returned by the immutable index.",
  schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
} as const;

const ifNoneMatchParameter = {
  name: "If-None-Match",
  in: "header",
  required: false,
  description: "Previously returned ETag for a conditional request.",
  schema: { type: "string" },
} as const;

const responseHeaders = {
  "Access-Control-Allow-Origin": { description: "Public, credential-free CORS access.", schema: { type: "string" } },
  "Access-Control-Expose-Headers": { description: "Headers exposed to browser clients.", schema: { type: "string" } },
  "Cache-Control": { description: "Mutable revalidation or immutable revision caching policy.", schema: { type: "string" } },
  "Content-Length": { description: "Response body size in bytes; omitted on 304 responses.", schema: { type: "integer", minimum: 0 } },
  ETag: { description: "Quoted SHA-256 digest of the response body.", schema: { type: "string" } },
  "X-Content-Type-Options": { description: "Always `nosniff`.", schema: { type: "string", const: "nosniff" } },
} as const;

const errorResponses = {
  "404": { $ref: "#/components/responses/NotFound" },
  "405": { $ref: "#/components/responses/MethodNotAllowed" },
  "500": { $ref: "#/components/responses/StorageFailure" },
} as const;

function getOperation(operationId: string, description: string, schema: string, parameters: readonly JsonObject[] = []) {
  return {
    operationId,
    summary: description.split(".")[0],
    description: `${description} HEAD returns identical status and headers without a body; OPTIONS returns the CORS policy. POST, PUT, PATCH, and DELETE return the frozen JSON error envelope with 405 and recovery guidance is documented at ${siteUrl("/docs/examples-api#errors")}.`,
    security: [],
    parameters: [...parameters, ifNoneMatchParameter],
    responses: {
      "200": {
        description: "The requested JSON artifact.",
        headers: responseHeaders,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
      },
      "304": { $ref: "#/components/responses/NotModified" },
      ...errorResponses,
    },
  };
}

function headOperation(operationId: string, description: string, parameters: readonly JsonObject[] = []) {
  return {
    operationId,
    summary: description.split(".")[0],
    description,
    security: [],
    parameters: [...parameters, ifNoneMatchParameter],
    responses: {
      "200": { description: "The artifact exists; no response body is returned.", headers: responseHeaders },
      "304": { $ref: "#/components/responses/NotModified" },
      ...errorResponses,
    },
  };
}

function optionsOperation(operationId: string, description: string, parameters: readonly JsonObject[] = []) {
  return {
    operationId,
    summary: "Read the CORS policy",
    description,
    security: [],
    parameters,
    responses: {
      "204": { $ref: "#/components/responses/CorsPreflight" },
      "405": { $ref: "#/components/responses/MethodNotAllowed" },
      "500": { $ref: "#/components/responses/StorageFailure" },
    },
  };
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "vgpu Examples Discovery API",
    version: "1.0.0",
    description: "Tokenless, read-only discovery for immutable vgpu example indexes, manifests, and hypermedia-linked source artifacts. Prefer `npx vgpu examples` for compatibility and integrity checks.",
    license: { name: "MIT", url: "https://github.com/vercel-labs/vgpu/blob/main/LICENSE" },
  },
  servers: [{ url: siteUrl("/").replace(/\/$/u, ""), description: "Canonical production origin" }],
  security: [],
  paths: {
    "/.well-known/vgpu-examples.json": {
      get: getOperation("discoverExamplesApi", "Discover supported examples API contracts and the current index pointer.", "ExamplesDiscovery"),
      head: headOperation("headExamplesDiscovery", "Check discovery availability and validators without downloading its JSON body."),
      options: optionsOperation("optionsExamplesDiscovery", "Returns the public methods and request headers permitted for discovery."),
    },
    "/api/examples/v1/latest.json": {
      get: getOperation("getLatestExamplesRevision", "Resolve the mutable pointer to the latest immutable examples revision and its index digest.", "LatestPointer"),
      head: headOperation("headLatestExamplesRevision", "Check the latest pointer and validators without downloading its JSON body."),
      options: optionsOperation("optionsLatestExamplesRevision", "Returns the public methods and request headers permitted for the latest pointer."),
    },
    "/api/examples/v1/revisions/{revision}/index.json": {
      get: getOperation("getExamplesRevisionIndex", "Fetch the immutable index for one verified revision; follow each returned manifestUrl.", "ImmutableIndex", [revisionParameter]),
      head: headOperation("headExamplesRevisionIndex", "Check an immutable revision index and validators without downloading its JSON body.", [revisionParameter]),
      options: optionsOperation("optionsExamplesRevisionIndex", "Returns the public methods and request headers permitted for a revision index.", [revisionParameter]),
    },
    "/api/examples/v1/revisions/{revision}/examples/{exampleId}/manifest.json": {
      get: getOperation("getExampleManifest", "Fetch an immutable example manifest whose files contain raw artifact URLs as hypermedia links.", "ExampleManifest", [revisionParameter, exampleIdParameter]),
      head: headOperation("headExampleManifest", "Check an immutable example manifest and validators without downloading its JSON body.", [revisionParameter, exampleIdParameter]),
      options: optionsOperation("optionsExampleManifest", "Returns the public methods and request headers permitted for an example manifest.", [revisionParameter, exampleIdParameter]),
    },
  },
  components: {
    schemas: {
      ExamplesDiscovery: rewriteLocalRefs(discoverySchema, "ExamplesDiscovery"),
      ExamplesIndex: rewriteLocalRefs(indexSchema, "ExamplesIndex"),
      LatestPointer: schemaVariant(indexVariants[0], indexDefs, "LatestPointer"),
      ImmutableIndex: schemaVariant(indexVariants[1], indexDefs, "ImmutableIndex"),
      ExampleManifest: rewriteLocalRefs(manifestSchema, "ExampleManifest"),
      ExamplesError: rewriteLocalRefs(errorSchema, "ExamplesError"),
    },
    responses: {
      NotModified: {
        description: "The supplied ETag still identifies the current representation.",
        headers: responseHeaders,
      },
      NotFound: {
        description: "The requested revision or artifact was not found. Rediscover from the well-known endpoint and follow its current links.",
        headers: responseHeaders,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ExamplesError" } } },
      },
      MethodNotAllowed: {
        description: "Only GET, HEAD, and OPTIONS are supported. Retry with one of the methods in the Allow header.",
        headers: { ...responseHeaders, Allow: { description: "Always `GET, HEAD, OPTIONS`.", schema: { type: "string" } } },
        content: { "application/json": { schema: { $ref: "#/components/schemas/ExamplesError" } } },
      },
      StorageFailure: {
        description: "Artifact verification or storage failed. Retry later; do not treat this opaque error as a missing example.",
        headers: responseHeaders,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ExamplesError" } } },
      },
      CorsPreflight: {
        description: "Public CORS policy; no response body.",
        headers: {
          "Access-Control-Allow-Origin": { description: "Always `*`.", schema: { type: "string", const: "*" } },
          "Access-Control-Allow-Methods": { description: "Always `GET, HEAD, OPTIONS`.", schema: { type: "string" } },
          "Access-Control-Allow-Headers": { description: "Allows conditional `If-None-Match` requests.", schema: { type: "string" } },
        },
      },
    },
  },
} as const;
