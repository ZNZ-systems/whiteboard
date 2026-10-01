import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RESPONSE_BYTES,
  authorizePath,
  localRequest,
  parseDiscovery,
  probeConnection,
} from "./connection";
import { canonicalIssue, messageSchema } from "./protocol";

const discovery = {
  version: 1,
  instanceId: "01fd786d-dd80-4d39-973f-9b56df568af5",
  url: "http://127.0.0.1:5570",
  serverPid: 123,
  token: "test-only-local-credential",
};

const binding = {
  issueUrl: "https://linear.app/acme/issue/ENG-12",
  reviewId: "review-one",
  version: 3,
  title: "Saved review",
};

afterEach(() => vi.useRealTimers());

describe("Linear issue identity", () => {
  it("binds the workspace and issue independently of title and tracking parameters", () => {
    expect(
      canonicalIssue(
        "https://linear.app/acme/issue/ENG-12/a-title?view=detail#comments",
      ),
    ).toBe(binding.issueUrl);
    expect(
      canonicalIssue("https://linear.app/another/issue/ENG-12/title"),
    ).toBe("https://linear.app/another/issue/ENG-12");
  });

  it.each([
    "http://linear.app/acme/issue/ENG-12",
    "https://linear.app.evil.test/acme/issue/ENG-12",
    "https://user@linear.app/acme/issue/ENG-12",
    "https://linear.app:443/acme/issue/ENG-12",
    "https://linear.app/acme/project/ENG-12",
    "https://linear.app/acme/issue/ENG-12/title/other",
    "https://linear.app/acme/issue/eng-12",
    "https://linear.app/acme/issue/ENG-0",
    "https://linear.app/acme/issue/ENG-12%2fother",
    "https://linear.app/acme/issue/ENG-12/title%2fother",
    "https://linear.app/acme/other/../issue/ENG-12",
    "https://linear.app/acme/%2e/issue/ENG-12",
    "https://linear.app/acme\\issue\\ENG-12",
    " https://linear.app/acme/issue/ENG-12",
  ])("rejects unsupported or ambiguous issue URL %s", (url) => {
    expect(canonicalIssue(url)).toBeNull();
  });
});

describe("private discovery import", () => {
  it("accepts only the local server discovery fields", () => {
    expect(parseDiscovery(JSON.stringify(discovery))).toEqual(discovery);
    expect(
      parseDiscovery(JSON.stringify({ ...discovery, url: discovery.url + "/" }))
        .url,
    ).toBe(discovery.url);
  });

  it.each([
    "https://127.0.0.1:5570",
    "http://localhost:5570",
    "http://127.1:5570",
    "http://2130706433:5570",
    "http://127.0.0.1.evil.test:5570",
    "http://127.0.0.1:5570@evil.test",
    "http://user:secret@127.0.0.1:5570",
    "http://127.0.0.1:5570/path",
    "http://127.0.0.1:5570?token=secret",
    "http://127.0.0.1:5570#secret",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:05570",
    "http://[::1]:5570",
  ])("rejects unsafe server origin %s", (url) => {
    expect(() => parseDiscovery(JSON.stringify({ ...discovery, url }))).toThrow(
      "Invalid server.json",
    );
  });

  it.each([
    {},
    { ...discovery, token: "" },
    { ...discovery, token: "a\r\nb" },
    { ...discovery, serverPid: -1 },
    { ...discovery, version: 2 },
    { ...discovery, instanceId: "other" },
    { ...discovery, extra: true },
  ])("rejects malformed discovery without echoing its credential", (value) => {
    expect(() => parseDiscovery(JSON.stringify(value))).toThrow(
      "Invalid server.json",
    );

    expect(() => parseDiscovery(JSON.stringify(value))).not.toThrow(
      discovery.token,
    );
  });

  it("rejects invalid and oversized JSON", () => {
    expect(() => parseDiscovery("{")).toThrow("Invalid server.json");
    expect(() => parseDiscovery(" ".repeat(16385))).toThrow(
      "Invalid server.json",
    );
  });

  it("authenticates the probe and rejects a different server identity", async () => {
    const connection = parseDiscovery(JSON.stringify(discovery));

    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toEqual({ "x-review-token": discovery.token });
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");

      return Response.json({
        ok: true,
        instanceId: "809cc384-1d3d-4b16-b55d-5807ac97e2a8",
      });
    });

    await expect(probeConnection(connection, request)).rejects.toThrow(
      "different Whiteboard server",
    );
    expect(request).toHaveBeenCalledWith(
      `${discovery.url}/health`,
      expect.any(Object),
    );
  });
});

describe("pinned read-only request paths", () => {
  it.each([
    "",
    "/progress",
    "/file?file=src%2Ffile.ts&side=head",
    "/diff?format=files",
    "/commits",
    "/history",
    "/tree?side=head",
    "/resources/image-one",
    "/maps/map-one",
    "/structural-diff?file=src%2Ffile.ts",
  ])("pins permitted route %s", (suffix) => {
    const path = authorizePath(
      `/reviews-api/review-one${suffix}`,
      binding,
    ).path;

    expect(
      new URL(path, "http://test.invalid").searchParams.get("version"),
    ).toBe("3");
  });

  it.each([
    "/reviews-api",
    "/reviews-api/other?version=3",
    "/reviews-api/review-one/watch",
    "/reviews-api/review-one/open",
    "/reviews-api/review-one/versions",
    "/reviews-api/commands",
    "/auth",
    "/health",
    "http://127.0.0.1:5570/reviews-api/review-one",
    "//evil.test/reviews-api/review-one",
    "/reviews-api/review-one?version=4",
    "/reviews-api/review-one?version=03",
    "/reviews-api/review-one?version=3&version=4",
    "/reviews-api/review-one?token=secret",
    "/reviews-api/review-one?unknown=true",
    "/reviews-api/review-one#fragment",
    "/reviews-api/review-one/../other",
    "/reviews-api/review-one/%2e%2e/other",
    "/reviews-api/other/../review-one",
    "/reviews-api/review-one/resources/id/extra",
    "/reviews-api/review-one/resources/a%2fb",
    "/reviews-api/review-one/file?file=../secret&side=head",
    "/reviews-api/review-one/file?file=%2Fetc%2Fpasswd&side=head",
    "/reviews-api/review-one/file?file=a&side=head&side=base",
    "/reviews-api/review-one/file?file=a&side=invalid",
    "/reviews-api/review-one?full=false",
    "/reviews-api/review-one\n",
  ])("blocks route or query escalation %s", (path) => {
    expect(() => authorizePath(path, binding)).toThrow(
      "Only read-only requests",
    );
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])(
    "rejects method %s instead of faking a write",
    (method) => {
      expect(
        messageSchema.safeParse({
          type: "review:request",
          issueUrl: binding.issueUrl,
          reviewId: binding.reviewId,
          version: binding.version,
          method,
          path: "/reviews-api/review-one",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects caller headers and request bodies", () => {
    const message = {
      type: "review:request",
      issueUrl: binding.issueUrl,
      reviewId: binding.reviewId,
      version: binding.version,
      path: "/reviews-api/review-one",
      method: "GET",
    };

    expect(messageSchema.safeParse(message).success).toBe(true);
    expect(
      messageSchema.safeParse({
        ...message,
        headers: { "x-review-token": "injected" },
      }).success,
    ).toBe(false);
    expect(messageSchema.safeParse({ ...message, body: "{}" }).success).toBe(
      false,
    );
  });
});

describe("bounded loopback transport", () => {
  const connection = parseDiscovery(JSON.stringify(discovery));

  it("returns binary bytes losslessly without response headers", async () => {
    const bytes = new Uint8Array([0, 255, 1, 128]);

    const result = await localRequest(
      connection,
      "/asset",
      async () =>
        new Response(bytes, {
          headers: { "content-type": "image/png", "x-secret": "never-return" },
        }),
    );

    expect(result.encoding).toBe("base64");
    expect(
      Uint8Array.from(atob(result.body), (char) => char.charCodeAt(0)),
    ).toEqual(bytes);
    expect(JSON.stringify(result)).not.toContain("never-return");
  });

  it("bounds advertised and streaming payload sizes", async () => {
    await expect(
      localRequest(
        connection,
        "/large",
        async () =>
          new Response("small", {
            headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
          }),
      ),
    ).rejects.toThrow("8 MiB");
    await expect(
      localRequest(
        connection,
        "/large",
        async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)),
      ),
    ).rejects.toThrow("8 MiB");
  });

  it.each([301, 302, 307, 401, 403, 500])(
    "does not relay redirect or error body for status %s",
    async (status) => {
      await expect(
        localRequest(
          connection,
          "/request",
          async () => new Response(discovery.token, { status }),
        ),
      ).rejects.not.toThrow(discovery.token);
    },
  );

  it("sanitizes network failures and times out stalled requests", async () => {
    await expect(
      localRequest(connection, "/request", async () => {
        throw new Error(discovery.token);
      }),
    ).rejects.toThrow("Cannot reach Whiteboard");
    vi.useFakeTimers();

    const request: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });

    await Promise.all([
      expect(localRequest(connection, "/stalled", request)).rejects.toThrow(
        "Cannot reach Whiteboard",
      ),
      vi.advanceTimersByTimeAsync(15000),
    ]);
  });
});
