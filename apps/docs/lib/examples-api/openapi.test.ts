import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

describe("examples OpenAPI document", () => {
  it("is valid OpenAPI 3.1 with no unresolved references", async () => {
    const validated = await SwaggerParser.validate(structuredClone(openApiDocument) as never);
    expect((validated as { openapi?: string }).openapi).toBe("3.1.0");
  });

  it("gives every operation a unique ID, description, typed parameters, and responses", () => {
    const operationIds = new Set<string>();

    for (const [path, pathItem] of Object.entries(openApiDocument.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;

        expect(operation.operationId, `${method.toUpperCase()} ${path} operationId`).toBeTruthy();
        expect(operationIds.has(operation.operationId), `duplicate operationId ${operation.operationId}`).toBe(false);
        operationIds.add(operation.operationId);
        expect(operation.description, `${method.toUpperCase()} ${path} description`).toBeTruthy();
        expect(Object.keys(operation.responses).length, `${method.toUpperCase()} ${path} responses`).toBeGreaterThan(0);

        for (const parameter of operation.parameters) {
          const typed = parameter as { in?: string; name?: string; schema?: { type?: string } };
          expect(typed.name, `${method.toUpperCase()} ${path} parameter name`).toBeTruthy();
          expect(typed.in, `${method.toUpperCase()} ${path} parameter location`).toMatch(/^(?:header|path|query|cookie)$/u);
          expect(typed.schema, `${method.toUpperCase()} ${path} parameter schema`).toBeTruthy();
          expect(typed.schema?.type, `${method.toUpperCase()} ${path} parameter type`).toBeTruthy();
        }
      }
    }

    expect(operationIds.size).toBe(12);
    expect(JSON.stringify(openApiDocument.paths)).not.toContain("{artifact}");
    expect(openApiDocument.components.responses.MethodNotAllowed).toBeTruthy();
  });
});
