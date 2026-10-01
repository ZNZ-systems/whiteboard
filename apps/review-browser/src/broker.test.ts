import type { JsonValue } from "@dev.fast/json";
import { describe, expect, it, vi } from "vitest";

import {
  type BrokerDependencies,
  type ExtensionState,
  createBroker,
  senderIssue,
} from "./broker";
import { parseDiscovery } from "./connection";
import type { ExtensionMessage } from "./protocol";

const extensionId = "test-extension";

const issueUrl = "https://linear.app/acme/issue/ENG-12";

const connection = parseDiscovery(
  JSON.stringify({
    version: 1,
    instanceId: "01fd786d-dd80-4d39-973f-9b56df568af5",
    url: "http://127.0.0.1:5570",
    serverPid: 123,
    token: "test-only-local-credential",
  }),
);

const binding = {
  issueUrl,
  reviewId: "review-one",
  version: 3,
  title: "Saved review",
};

const options: chrome.runtime.MessageSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/options.html`,
};

const content: chrome.runtime.MessageSender = {
  id: extensionId,
  url: issueUrl + "/title",
  origin: "https://linear.app",
  frameId: 0,
  tab: { id: 3, url: issueUrl + "/title" } as chrome.tabs.Tab,
};

const fileRequest: ExtensionMessage = {
  type: "review:request",
  issueUrl,
  reviewId: "review-one",
  version: 3,
  method: "GET",
  path: "/reviews-api/review-one/file?side=head&file=src%2Findex.ts",
};

const layoutRequest: ExtensionMessage = {
  type: "layout:route",
  issueUrl,
  reviewId: "review-one",
  version: 3,
  graph: { id: "graph", children: [], edges: [] },
  options: {},
};

function harness() {
  let state: ExtensionState = { connection, bindings: [binding] };
  let tabUrl = issueUrl + "/title";

  let transport: (url: URL) => Promise<Response> = async (url) => {
    if (url.pathname === "/health")
      return Response.json({ ok: true, instanceId: connection.instanceId });

    if (url.pathname === "/reviews-api")
      return Response.json([
        {
          ...binding,
          repositoryName: "sample",
          ignoredSecret: "private-catalog-field",
        },
      ]);

    if (url.pathname === "/reviews-api/review-one")
      return Response.json({
        reviewId: "review-one",
        version: Number(url.searchParams.get("version")),
        title: "Saved review",
        pins: { repositoryId: "repo-one", base: "base-sha", head: "head-sha" },
        document: [
          { type: "image", assetId: "image-one" },
          { type: "software_map", mapVersionId: "map-one" },
          { type: "trace_quote", traceId: "trace-one" },
        ],
      });

    if (url.pathname.endsWith("/history"))
      return Response.json([
        { version: 3, title: "Saved review", createdAt: "2026-01-01" },
        { version: 4, title: "Newer review", createdAt: "2026-01-02" },
      ]);

    return Response.json({ text: "saved file content" });
  };

  const request = vi.fn<typeof fetch>((input) =>
    transport(new URL(String(input))),
  );

  const openOptions = vi.fn<() => Promise<void>>(async () => undefined);
  const routeLayout = vi.fn<BrokerDependencies["routeLayout"]>(async () => []);

  const handle = createBroker({
    extensionId,
    request,
    load: async () => state,
    save: async (next) => {
      state = next;
    },
    tabUrl: async () => tabUrl,
    openOptions,
    routeLayout,
  });

  return {
    handle,
    request,
    openOptions,
    routeLayout,
    get state() {
      return state;
    },
    set state(next: ExtensionState) {
      state = next;
    },
    set tabUrl(next: string) {
      tabUrl = next;
    },
    set transport(next: (url: URL) => Promise<Response>) {
      transport = next;
    },
  };
}

describe("sender and per-issue authorization", () => {
  it("returns no server origin or token to the bound content script", async () => {
    const test = harness();

    const result = await test.handle(
      { type: "review:status", issueUrl },
      content,
    );

    expect(result).toEqual({ ok: true, value: { connected: true, binding } });
    expect(JSON.stringify(result)).not.toContain(connection.token);
    expect(JSON.stringify(result)).not.toContain(connection.url);
  });

  it.each([
    {},
    { ...content, id: "another-extension" },
    { ...content, frameId: 1 },
    { ...content, origin: "https://evil.test" },
    { ...content, url: "https://evil.test/acme/issue/ENG-12" },
    { ...content, url: "https://linear.app/other/issue/ENG-12" },
    { ...content, tab: undefined },
    { ...content, url: undefined },
  ])("silently ignores unknown content senders", async (sender) => {
    const test = harness();
    expect(senderIssue(sender, extensionId)).toBeNull();
    expect(await test.handle(fileRequest, sender)).toBeUndefined();
    expect(test.request).not.toHaveBeenCalled();
  });

  it("requires the current tab route and claimed issue to match the sender", async () => {
    const test = harness();
    expect(
      await test.handle(
        {
          type: "review:status",
          issueUrl: "https://linear.app/other/issue/ENG-12",
        },
        content,
      ),
    ).toBeUndefined();
    test.tabUrl = "https://linear.app/acme/issue/ENG-13";
    expect(await test.handle(fileRequest, content)).toBeUndefined();
    expect(test.request).not.toHaveBeenCalled();
  });

  it.each([
    "https://linear.app/auth/google/callback",
    "https://linear.app/acme/issue/ENG-11",
    "https://linear.app/other/issue/OTHER-1",
  ])(
    "authorizes the active issue after SPA navigation from %s",
    async (url) => {
      const test = harness();

      const sender: chrome.runtime.MessageSender = {
        ...content,
        url,
        documentLifecycle: "active",
      };

      expect(
        await test.handle({ type: "review:status", issueUrl }, sender),
      ).toEqual({ ok: true, value: { connected: true, binding } });
      expect(await test.handle(fileRequest, sender)).toMatchObject({
        ok: true,
        value: { body: JSON.stringify({ text: "saved file content" }) },
      });
      test.request.mockClear();
      test.tabUrl = "https://linear.app/acme/issue/ENG-13";
      expect(await test.handle(fileRequest, sender)).toBeUndefined();
      expect(test.request).not.toHaveBeenCalled();
    },
  );

  it.each(["cached", "prerender", "pending_deletion"] as const)(
    "does not authorize a %s document even on the same issue",
    async (documentLifecycle) => {
      const test = harness();
      expect(
        await test.handle(fileRequest, { ...content, documentLifecycle }),
      ).toBeUndefined();
      expect(test.request).not.toHaveBeenCalled();
    },
  );

  it.each(["https://evil.test/", "not a URL"])(
    "does not trust active-document metadata from %s",
    async (url) => {
      const test = harness();
      expect(
        await test.handle(fileRequest, {
          ...content,
          url,
          documentLifecycle: "active",
        }),
      ).toBeUndefined();
      expect(test.request).not.toHaveBeenCalled();
    },
  );

  it.each(["options:status", "options:catalog", "options:disconnect"])(
    "keeps privileged operation %s inaccessible to content",
    async (type) => {
      const test = harness();
      expect(await test.handle({ type }, content)).toBeUndefined();
      expect(test.request).not.toHaveBeenCalled();
      expect(test.state.connection).toEqual(connection);
    },
  );

  it("does not expose the catalog from another extension page", async () => {
    const test = harness();
    expect(
      await test.handle(
        { type: "options:catalog" },
        { ...options, url: `chrome-extension://${extensionId}/other.html` },
      ),
    ).toBeUndefined();
  });

  it("rejects wrong review IDs and versions before touching the server", async () => {
    const test = harness();

    for (const message of [
      { ...fileRequest, reviewId: "other" },
      { ...fileRequest, version: 4 },
    ]) {
      expect(await test.handle(message, content)).toMatchObject({ ok: false });
    }

    expect(test.request).not.toHaveBeenCalled();
  });

  it("injects only its own credential and forces the saved version", async () => {
    const test = harness();
    expect(await test.handle(fileRequest, content)).toMatchObject({
      ok: true,
      value: { body: JSON.stringify({ text: "saved file content" }) },
    });

    for (const [url, init] of test.request.mock.calls) {
      expect(new URL(String(url)).searchParams.get("version")).toBe("3");
      expect(init?.headers).toEqual({ "x-review-token": connection.token });
      expect(init?.body).toBeUndefined();
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
    }
  });

  it.each([
    "/reviews-api/other",
    "/reviews-api/review-one?version=4",
    "/reviews-api/review-one/watch",
    "/reviews-api/review-one/resources/not-in-document",
    "/reviews-api/review-one/maps/not-in-document",
    "/reviews-api/review-one/file?file=a&side=head&repositoryId=other-repository&base=b&head=h",
    "/reviews-api/review-one/file?file=a&side=head&commit=another-commit",
  ])("does not fetch an unauthorized path %s", async (path) => {
    const test = harness();
    expect(await test.handle({ ...fileRequest, path }, content)).toMatchObject({
      ok: false,
    });
    expect(
      test.request.mock.calls.every(
        ([url]) => new URL(String(url)).pathname === "/reviews-api/review-one",
      ),
    ).toBe(true);
  });

  it.each([
    "resources/image-one",
    "resources/trace-one",
    "maps/map-one",
    "file?file=a&side=head&repositoryId=repo-one&base=base-sha&head=head-sha",
  ])(
    "allows references retained in the pinned snapshot: %s",
    async (suffix) => {
      const test = harness();
      expect(
        await test.handle(
          { ...fileRequest, path: `/reviews-api/review-one/${suffix}` },
          content,
        ),
      ).toMatchObject({ ok: true });
    },
  );

  it("does not reveal titles or versions outside the binding via history", async () => {
    const test = harness();

    const result = await test.handle(
      { ...fileRequest, path: "/reviews-api/review-one/history" },
      content,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        body: JSON.stringify([
          { version: 3, title: "Saved review", createdAt: "2026-01-01" },
        ]),
      },
    });
  });

  it("rejects live worktree source even when content supplies a saved version", async () => {
    const test = harness();
    test.transport = async (url) =>
      url.pathname === "/reviews-api/review-one"
        ? Response.json({
            ...binding,
            target: { kind: "worktree" },
            pins: {
              repositoryId: "repo-one",
              base: "base-sha",
              head: "head-sha",
              worktreeRevision: "live",
            },
            document: [],
          })
        : Response.json({ text: "current working file" });

    const result = await test.handle(fileRequest, content);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Immutable source is unavailable"),
    });
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(
      await test.handle(
        {
          ...fileRequest,
          path:
            fileRequest.path +
            "&repositoryId=repo-one&base=base-sha&head=head-sha",
        },
        content,
      ),
    ).toMatchObject({ ok: false });
    expect(test.request).toHaveBeenCalledTimes(1);
  });

  it("allows immutable source references retained in a worktree document", async () => {
    const test = harness();
    test.transport = async (url) =>
      url.pathname === "/reviews-api/review-one"
        ? Response.json({
            ...binding,
            target: { kind: "worktree" },
            pins: {
              repositoryId: "repo-one",
              base: "base-sha",
              head: "head-sha",
              worktreeRevision: "live",
            },
            document: [
              {
                pins: {
                  repositoryId: "repo-one",
                  base: "saved-base",
                  head: "saved-head",
                },
              },
            ],
          })
        : Response.json({ text: "immutable source file" });

    const result = await test.handle(
      {
        ...fileRequest,
        path:
          fileRequest.path +
          "&repositoryId=repo-one&base=saved-base&head=saved-head",
      },
      content,
    );

    expect(result).toMatchObject({ ok: true });
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it("allows a selected commit only when it belongs to the saved review range", async () => {
    const test = harness();
    await test.handle(fileRequest, content);
    test.request.mockClear();
    const commit = "a".repeat(40);
    test.transport = async (url) =>
      url.pathname.endsWith("/commits")
        ? Response.json([{ commit }])
        : Response.json({ text: "commit diff" });
    expect(
      await test.handle(
        {
          ...fileRequest,
          path: `/reviews-api/review-one/diff?commit=${commit}`,
        },
        content,
      ),
    ).toMatchObject({ ok: true });
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(
      await test.handle(
        {
          ...fileRequest,
          path: `/reviews-api/review-one/diff?commit=${"b".repeat(40)}`,
        },
        content,
      ),
    ).toMatchObject({ ok: false });
    expect(test.request).toHaveBeenCalledTimes(3);
  });

  it("discards response data when the tab navigates during a fetch", async () => {
    const test = harness();
    await test.handle(fileRequest, content);
    test.transport = async () => {
      test.tabUrl = "https://linear.app/acme/issue/ENG-13";

      return Response.json({ confidential: "stale-response" });
    };

    const result = await test.handle(fileRequest, content);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("stale-response");
  });

  it("discards response data when a binding is revoked during a fetch", async () => {
    const test = harness();
    await test.handle(fileRequest, content);
    test.transport = async () => {
      test.state = { connection, bindings: [] };

      return Response.json({ confidential: "revoked-response" });
    };

    const result = await test.handle(fileRequest, content);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("revoked-response");
  });

  it("rejects writes explicitly without network requests", async () => {
    const test = harness();
    expect(
      await test.handle(
        { ...fileRequest, method: "POST", body: "{}" },
        content,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(test.request).not.toHaveBeenCalled();
  });
});

describe("background layout authorization", () => {
  it("routes only the bound saved review and performs no server requests", async () => {
    const test = harness();
    expect(await test.handle(layoutRequest, content)).toEqual({
      ok: true,
      value: [],
    });
    expect(test.routeLayout).toHaveBeenCalledWith(
      layoutRequest.graph,
      layoutRequest.options,
    );
    expect(test.request).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...content, id: "another-extension" },
    { ...content, frameId: 1 },
    { ...content, url: "https://linear.app/other/issue/ENG-12" },
    { ...content, origin: "https://evil.test" },
    options,
  ])(
    "ignores layout requests outside the matching top-level Linear sender",
    async (sender) => {
      const test = harness();
      expect(await test.handle(layoutRequest, sender)).toBeUndefined();
      expect(test.routeLayout).not.toHaveBeenCalled();
      expect(test.request).not.toHaveBeenCalled();
    },
  );

  it("requires both the claimed issue and the current tab route to match", async () => {
    const test = harness();
    expect(
      await test.handle(
        {
          ...layoutRequest,
          issueUrl: "https://linear.app/another/issue/ENG-12",
        },
        content,
      ),
    ).toBeUndefined();
    test.tabUrl = "https://linear.app/acme/issue/ENG-13";
    expect(await test.handle(layoutRequest, content)).toBeUndefined();
    expect(test.routeLayout).not.toHaveBeenCalled();
  });

  it.each([
    { ...layoutRequest, version: 4 },
    { ...layoutRequest, reviewId: "other-review" },
  ])(
    "rejects a layout for a different review or saved version",
    async (message) => {
      const test = harness();
      expect(await test.handle(message, content)).toMatchObject({ ok: false });
      expect(test.routeLayout).not.toHaveBeenCalled();
      expect(test.request).not.toHaveBeenCalled();
    },
  );

  it("rejects layout without a binding or configured connection", async () => {
    const test = harness();
    test.state = { connection, bindings: [] };
    expect(await test.handle(layoutRequest, content)).toMatchObject({
      ok: false,
    });
    test.state = { connection: null, bindings: [binding] };
    expect(await test.handle(layoutRequest, content)).toMatchObject({
      ok: false,
    });
    expect(test.routeLayout).not.toHaveBeenCalled();
  });

  it("discards routed results when the tab navigates while routing", async () => {
    const test = harness();
    test.routeLayout.mockImplementation(async () => {
      test.tabUrl = "https://linear.app/acme/issue/ENG-13";

      return [];
    });
    expect(await test.handle(layoutRequest, content)).toMatchObject({
      ok: false,
    });
    expect(test.routeLayout).toHaveBeenCalledOnce();
    expect(test.request).not.toHaveBeenCalled();
  });

  it("discards routed results if the saved binding changes while routing", async () => {
    const test = harness();
    test.routeLayout.mockImplementation(async () => {
      test.state = { connection, bindings: [{ ...binding, version: 4 }] };

      return [];
    });
    expect(await test.handle(layoutRequest, content)).toMatchObject({
      ok: false,
    });
    expect(test.routeLayout).toHaveBeenCalledOnce();
  });

  it("discards routed results if the connection is revoked while routing", async () => {
    const test = harness();
    test.routeLayout.mockImplementation(async () => {
      test.state = { connection: null, bindings: [] };

      return [];
    });
    expect(await test.handle(layoutRequest, content)).toMatchObject({
      ok: false,
    });
    expect(test.routeLayout).toHaveBeenCalledOnce();
  });

  it("does not reveal raw worker errors or credentials", async () => {
    const test = harness();
    test.routeLayout.mockRejectedValue(new Error(connection.token));
    const result = await test.handle(layoutRequest, content);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(connection.token);
    expect(test.request).not.toHaveBeenCalled();
  });
});

describe("trusted configuration and binding lifecycle", () => {
  it("probes imported identity before persisting and clears old bindings", async () => {
    const test = harness();
    expect(
      await test.handle(
        { type: "options:connect", source: JSON.stringify(connection) },
        options,
      ),
    ).toEqual({ ok: true, value: null });
    expect(test.state).toEqual({ connection, bindings: [] });
  });

  it("preserves the existing connection when import is malformed or the server is down", async () => {
    const test = harness();
    expect(
      await test.handle({ type: "options:connect", source: "{}" }, options),
    ).toMatchObject({ ok: false });
    test.transport = async () => {
      throw new Error(connection.token);
    };

    const result = await test.handle(
      { type: "options:connect", source: JSON.stringify(connection) },
      options,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot reach Whiteboard"),
    });
    expect(JSON.stringify(result)).not.toContain(connection.token);
    expect(test.state).toEqual({ connection, bindings: [binding] });
  });

  it("gives catalog metadata only to options, stripping unrelated fields", async () => {
    const test = harness();
    const result = await test.handle({ type: "options:catalog" }, options);
    expect(result).toMatchObject({
      ok: true,
      value: [{ reviewId: binding.reviewId, version: 3 }],
    });
    expect(JSON.stringify(result)).not.toContain("private-catalog-field");
    expect(JSON.stringify(result)).not.toContain(connection.token);
  });

  it("binds a canonical workspace issue to a verified saved version", async () => {
    const test = harness();

    const result = await test.handle(
      {
        type: "options:bind",
        issueUrl: issueUrl + "/new-title?view=details",
        reviewId: "review-one",
        version: 2,
      },
      options,
    );

    expect(result).toMatchObject({ ok: true, value: { issueUrl, version: 2 } });
    expect(test.state.bindings).toEqual([{ ...binding, version: 2 }]);
  });

  it("does not bind when the server returns a different saved version", async () => {
    const test = harness();
    test.transport = async () =>
      Response.json({ ...binding, version: 99, document: [] });
    expect(
      await test.handle(
        { type: "options:bind", issueUrl, reviewId: "review-one", version: 2 },
        options,
      ),
    ).toMatchObject({ ok: false });
    expect(test.state.bindings).toEqual([binding]);
  });

  it("refreshes only the same bound review and never fetches the catalog", async () => {
    const test = harness();
    expect(
      await test.handle(
        {
          type: "review:refresh",
          issueUrl,
          reviewId: "review-one",
          version: 3,
        },
        content,
      ),
    ).toMatchObject({ ok: true, value: { ...binding, version: 4 } });
    expect(test.state.bindings).toEqual([{ ...binding, version: 4 }]);
    expect(
      test.request.mock.calls.every(([url]) =>
        new URL(String(url)).pathname.startsWith("/reviews-api/review-one"),
      ),
    ).toBe(true);
  });

  it("unbinding revokes future file requests; disconnect removes the credential", async () => {
    const test = harness();
    await test.handle({ type: "options:unbind", issueUrl }, options);
    expect(await test.handle(fileRequest, content)).toMatchObject({
      ok: false,
    });
    expect(test.request).not.toHaveBeenCalled();
    await test.handle({ type: "options:disconnect" }, options);
    expect(test.state).toEqual({ connection: null, bindings: [] });
  });

  it("opens only the fixed options page for a validated issue", async () => {
    const test = harness();
    expect(
      await test.handle({ type: "review:options", issueUrl }, content),
    ).toEqual({ ok: true, value: null });
    expect(test.openOptions).toHaveBeenCalledOnce();
  });

  it("ignores malformed messages from unauthenticated senders", async () => {
    const test = harness();

    const payloads: JsonValue[] = [
      null,
      3,
      "status",
      {},
      { type: "options:connect", source: JSON.stringify(connection) },
    ];

    for (const message of payloads)
      expect(await test.handle(message, {})).toBeUndefined();
    expect(test.request).not.toHaveBeenCalled();
  });
});
