import { describe, expect, it, vi } from "vitest";
import { FACTORY_LIMITS } from "../src/constants.ts";
import {
  assertAllowedGitHubRequest,
  buildDuplicateSearchQuery,
  buildDuplicateSearchTerms,
  fetchGitHubIssueContext,
  truncateText,
  type FetchLike,
} from "../src/github-client.ts";

function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function repositoryPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 1230165564,
    owner: { login: "vercel-labs" },
    name: "vgpu",
    full_name: "vercel-labs/vgpu",
    ...overrides,
  };
}

function issuePayload(
  number = 123,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    number,
    html_url: `https://github.com/vercel-labs/vgpu/issues/${number}`,
    title: "Renderer crashes with nested struct uniforms",
    body: "Expected a rendered frame, but compilation fails.",
    user: { login: "reporter" },
    created_at: "2026-09-01T12:00:00Z",
    labels: [{ name: "bug", description: null }],
    state: "open",
    ...overrides,
  };
}

function successfulFetch(
  overrides: { labels?: unknown; search?: unknown } = {}
): FetchLike {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/repos/vercel-labs/vgpu") {
      return jsonResponse(repositoryPayload());
    }
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse(
        overrides.labels ?? [
          { name: "bug", description: "Something is not working" },
        ]
      );
    }
    if (url.pathname === "/search/issues") {
      return jsonResponse(overrides.search ?? { items: [issuePayload(100)] });
    }
    return jsonResponse(issuePayload());
  });
}

describe("GitHub endpoint guard", () => {
  it("allows only the four expected GET endpoint shapes", () => {
    expect(
      assertAllowedGitHubRequest(
        "https://api.github.com/repos/vercel-labs/vgpu",
        { method: "GET" }
      )
    ).toBe("repository");
    expect(
      assertAllowedGitHubRequest(
        "https://api.github.com/repos/vercel-labs/vgpu/issues/12",
        { method: "GET" }
      )
    ).toBe("issue");
    expect(
      assertAllowedGitHubRequest(
        "https://api.github.com/repos/vercel-labs/vgpu/labels?per_page=100",
        { method: "GET" }
      )
    ).toBe("labels");
    expect(
      assertAllowedGitHubRequest(
        "https://api.github.com/search/issues?q=repo%3Avercel-labs%2Fvgpu+is%3Aissue+in%3Atitle+shader+error&per_page=5",
        { method: "GET" }
      )
    ).toBe("search");
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    'blocks the "%s" method',
    (method) => {
      expect(() =>
        assertAllowedGitHubRequest(
          "https://api.github.com/repos/vercel-labs/vgpu",
          { method }
        )
      ).toThrow("non-GET");
    }
  );

  it.each([
    "https://github.com/repos/vercel-labs/vgpu/issues/12",
    "https://evil.example/repos/vercel-labs/vgpu/issues/12",
    "https://api.github.com/repos/another/vgpu",
    "https://api.github.com/repos/vercel-labs/vgpu/",
    "https://api.github.com/repos/vercel-labs/vgpu?ref=main",
    "https://api.github.com/repos/vercel-labs/vgpu/issues",
    "https://api.github.com/repos/another/vgpu/issues/12",
    "https://api.github.com/repos/vercel-labs/vgpu/issues/12?comments=true",
    "https://api.github.com/repos/vercel-labs/vgpu/labels?per_page=99",
    "https://api.github.com/search/issues?q=repo%3Aother%2Fvgpu+is%3Aissue+in%3Atitle+shader&per_page=5",
  ])("blocks URL outside the narrow allowlist: %s", (url) => {
    expect(() => assertAllowedGitHubRequest(url)).toThrow("Blocked GitHub");
  });
});

describe("duplicate query normalization", () => {
  it("uses at most eight meaningful, unique, injection-safe terms", () => {
    expect(
      buildDuplicateSearchTerms(
        "The Shader shader CRASH when foo/bar repo:evil is:pr one two three four five six seven eight nine"
      )
    ).toEqual(["shader", "crash", "foo", "bar", "repo", "evil", "one", "two"]);
    expect(buildDuplicateSearchQuery("a the is")).toBeNull();
    expect(buildDuplicateSearchQuery("Shader fails")).toBe(
      "repo:vercel-labs/vgpu is:issue in:title shader fails"
    );
  });
});

describe("fetchGitHubIssueContext", () => {
  it("uses GET, redirect:error, fixed endpoints, and keeps GitHub auth in trusted requests", async () => {
    const fetch = successfulFetch();
    const context = await fetchGitHubIssueContext(123, {
      fetch,
      token: "github-secret",
      timeoutMs: 50,
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe("https://api.github.com");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer github-secret"
      );
    }
    expect(context.repository).toEqual({
      id: 1230165564,
      owner: "vercel-labs",
      name: "vgpu",
    });
    expect(context.availableSourceIds).toEqual(["issue:123", "duplicate:100"]);
    expect(context.capabilities).toEqual({
      labelsAvailable: true,
      duplicateSearchAvailable: true,
    });
  });

  it("works anonymously and never requests comments or issue links", async () => {
    const fetch = successfulFetch();
    await fetchGitHubIssueContext(123, { fetch });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(
      calls.every(
        ([, init]) => !new Headers(init?.headers).has("authorization")
      )
    ).toBe(true);
    expect(
      calls.map(
        ([input]) =>
          new URL(input instanceof Request ? input.url : input).pathname
      )
    ).toEqual([
      "/repos/vercel-labs/vgpu",
      "/repos/vercel-labs/vgpu/issues/123",
      "/repos/vercel-labs/vgpu/labels",
      "/search/issues",
    ]);
  });

  it.each([
    ["numeric ID", { id: 999 }],
    ["owner login", { owner: { login: "attacker" } }],
    ["name", { name: "renamed" }],
    ["canonical full name", { full_name: "vercel-labs/renamed" }],
  ])("fails closed when the repository %s does not match", async (_, value) => {
    const fetch: FetchLike = vi.fn(async () =>
      jsonResponse(repositoryPayload(value))
    );

    await expect(fetchGitHubIssueContext(123, { fetch })).rejects.toThrow(
      "repository identity verification failed"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when repository identity cannot be fetched", async () => {
    const fetch: FetchLike = vi.fn(async () => jsonResponse({}, 503));

    await expect(fetchGitHubIssueContext(123, { fetch })).rejects.toThrow(
      "repository identity request failed with HTTP 503"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds all untrusted model context", async () => {
    const longText = "x".repeat(20_000);
    const longDescription = "d".repeat(200);
    const labels = Array.from({ length: 100 }, (_, index) => ({
      name: `${index}`.padEnd(80, "l"),
      description: longDescription,
    }));
    const candidates = Array.from({ length: 8 }, (_, index) =>
      issuePayload(200 + index, { title: longText, body: longText })
    );
    const fetch: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/repos/vercel-labs/vgpu") {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith("/labels")) return jsonResponse(labels);
      if (url.pathname === "/search/issues")
        return jsonResponse({ items: candidates });
      return jsonResponse(
        issuePayload(123, {
          title: longText,
          body: longText,
          labels: Array.from({ length: 40 }, (_, index) => `label-${index}`),
        })
      );
    });

    const context = await fetchGitHubIssueContext(123, { fetch });
    expect(Array.from(context.issue.title)).toHaveLength(256);
    expect(Array.from(context.issue.body)).toHaveLength(
      FACTORY_LIMITS.issueBodyCharacters
    );
    expect(context.issue.labels).toHaveLength(30);
    expect(context.availableLabels).toHaveLength(100);
    expect(context.availableLabels[0]!.name).toHaveLength(50);
    expect(context.availableLabels[0]!.description).toHaveLength(
      FACTORY_LIMITS.labelDescriptionCharacters
    );
    expect(context.duplicateCandidates).toHaveLength(5);
    expect(Array.from(context.duplicateCandidates[0]!.title)).toHaveLength(256);
    expect(
      Array.from(context.duplicateCandidates[0]!.bodyExcerpt)
    ).toHaveLength(FACTORY_LIMITS.duplicateBodyCharacters);
  });

  it("keeps astral Unicode within schema-compatible UTF-16 bounds", async () => {
    const emojiText = "😀".repeat(10_000);
    const fetch: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/repos/vercel-labs/vgpu") {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith("/labels")) {
        return jsonResponse([
          { name: "😀".repeat(50), description: emojiText },
        ]);
      }
      if (url.pathname === "/search/issues") {
        return jsonResponse({
          items: [issuePayload(200, { title: emojiText, body: emojiText })],
        });
      }
      return jsonResponse(
        issuePayload(123, {
          body: emojiText,
          labels: ["😀".repeat(50)],
        })
      );
    });

    const context = await fetchGitHubIssueContext(123, { fetch });
    expect(context.issue.body.length).toBeLessThanOrEqual(
      FACTORY_LIMITS.issueBodyCharacters
    );
    expect(context.issue.labels[0]!.length).toBeLessThanOrEqual(50);
    expect(context.availableLabels[0]!.name.length).toBeLessThanOrEqual(50);
    expect(context.availableLabels[0]!.description!.length).toBeLessThanOrEqual(
      FACTORY_LIMITS.labelDescriptionCharacters
    );
    expect(context.duplicateCandidates[0]!.title.length).toBeLessThanOrEqual(
      256
    );
    expect(
      context.duplicateCandidates[0]!.bodyExcerpt.length
    ).toBeLessThanOrEqual(FACTORY_LIMITS.duplicateBodyCharacters);
    expect(JSON.stringify(context)).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u
    );
  });

  it("degrades safely when labels and duplicate search fail", async () => {
    const fetch: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/repos/vercel-labs/vgpu") {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith("/labels")) return jsonResponse({}, 500);
      if (url.pathname === "/search/issues") return jsonResponse({}, 429);
      return jsonResponse(issuePayload());
    });

    const context = await fetchGitHubIssueContext(123, { fetch });
    expect(context.availableLabels).toEqual([]);
    expect(context.duplicateCandidates).toEqual([]);
    expect(context.capabilities).toEqual({
      labelsAvailable: false,
      duplicateSearchAvailable: false,
    });
    expect(context.contextWarnings).toHaveLength(2);
  });

  it("marks duplicate search unavailable when no meaningful title terms exist", async () => {
    const fetch: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/repos/vercel-labs/vgpu") {
        return jsonResponse(repositoryPayload());
      }
      if (url.pathname.endsWith("/labels")) return jsonResponse([]);
      if (url.pathname === "/search/issues")
        throw new Error("search must not run");
      return jsonResponse(issuePayload(123, { title: "a and the" }));
    });
    const context = await fetchGitHubIssueContext(123, { fetch });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(context.capabilities.duplicateSearchAvailable).toBe(false);
    expect(context.contextWarnings[0]).toContain("skipped");
  });

  it("filters pull requests and the source issue from duplicate results", async () => {
    const fetch = successfulFetch({
      search: {
        items: [
          issuePayload(123),
          issuePayload(124, { pull_request: { url: "ignored" } }),
          issuePayload(125),
        ],
      },
    });
    const context = await fetchGitHubIssueContext(123, { fetch });
    expect(
      context.duplicateCandidates.map((candidate) => candidate.number)
    ).toEqual([125]);
  });

  it("rejects a pull request supplied through the issues endpoint", async () => {
    const fetch: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname === "/repos/vercel-labs/vgpu"
        ? jsonResponse(repositoryPayload())
        : jsonResponse(issuePayload(123, { pull_request: {} }));
    });
    await expect(fetchGitHubIssueContext(123, { fetch })).rejects.toThrow(
      "pull request"
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires the requested source issue and validates its identity", async () => {
    const missing: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname === "/repos/vercel-labs/vgpu"
        ? jsonResponse(repositoryPayload())
        : jsonResponse({}, 404);
    });
    await expect(
      fetchGitHubIssueContext(123, { fetch: missing })
    ).rejects.toThrow("HTTP 404");

    const wrongIssue: FetchLike = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname === "/repos/vercel-labs/vgpu"
        ? jsonResponse(repositoryPayload())
        : jsonResponse(issuePayload(999));
    });
    await expect(
      fetchGitHubIssueContext(123, { fetch: wrongIssue })
    ).rejects.toThrow("when #123 was requested");
  });

  it("rejects oversized API responses before parsing", async () => {
    const fetch: FetchLike = vi.fn(async () =>
      jsonResponse(repositoryPayload(), 200, {
        "content-length": String(FACTORY_LIMITS.githubResponseBytes + 1),
      })
    );
    await expect(fetchGitHubIssueContext(123, { fetch })).rejects.toThrow(
      "size limit"
    );
  });

  it("rejects a chunked response that crosses the byte limit", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify(repositoryPayload())
    );
    const fetch: FetchLike = vi.fn(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoded.slice(0, 8));
              controller.enqueue(encoded.slice(8));
              controller.close();
            },
          }),
          { status: 200 }
        )
      )
    );

    await expect(
      fetchGitHubIssueContext(123, { fetch, responseByteLimit: 10 })
    ).rejects.toThrow("size limit");
  });

  it("enforces the GitHub request deadline", async () => {
    const requestSignals: AbortSignal[] = [];
    const fetch: FetchLike = vi.fn((_input, init) => {
      const requestSignal = init?.signal;
      if (requestSignal !== undefined && requestSignal !== null) {
        requestSignals.push(requestSignal);
      }
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(requestSignal.reason),
          { once: true }
        );
      });
    });

    await expect(
      fetchGitHubIssueContext(123, { fetch, timeoutMs: 5 })
    ).rejects.toThrow("before receiving a response");
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]!.aborted).toBe(true);
  });
});

describe("truncateText", () => {
  it("matches schema length units without splitting Unicode code points", () => {
    expect(truncateText("A😀B", 4)).toBe("A😀B");
    expect(truncateText("A😀BC", 4)).toBe("A😀…");
    expect(truncateText("A😀B", 3)).toBe("A…");
  });
});
