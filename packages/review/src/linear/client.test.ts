import { describe, expect, it, vi } from "vitest";

import { buildLinearAttachment } from "./attachment.js";
import { LinearAttachmentClient } from "./client.js";

const issueId = "b59fbcea-fbca-465f-b9be-393680f15909";

const attachmentId = "1487db11-ae85-4268-bc39-4b62d4348930";

const issue = {
  id: issueId,
  identifier: "ENG-42",
  url: "https://linear.app/acme/issue/ENG-42",
};

const preview = buildLinearAttachment(
  {
    reviewId: "review-42",
    version: 2,
    title: "Idempotent writes",
    document: [],
  },
  "https://reviews.example.com/write-path",
);

describe("Linear attachment API", () => {
  it.each([
    [{ LINEAR_API_KEY: "test-key" }, "test-key"],
    [{ LINEAR_ACCESS_TOKEN: "test-oauth-token" }, "Bearer test-oauth-token"],
  ])(
    "resolves issue identifiers with the configured authentication",
    async (env, authorization) => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ data: { issue } }),
      );

      const client = new LinearAttachmentClient(env, request);

      await expect(client.issue("ENG-42")).resolves.toEqual(issue);
      const [url, init] = request.mock.calls[0];

      expect(url).toBe("https://api.linear.app/graphql");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        authorization,
      );
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body)).variables).toEqual({
        id: "ENG-42",
      });
    },
  );

  it("publishes the rich metadata and preserves the URL used for idempotency", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          attachmentCreate: { success: true, attachment: { id: attachmentId } },
        },
      }),
    );

    const client = new LinearAttachmentClient(
      { LINEAR_API_KEY: "test-key" },
      request,
    );

    await expect(client.attach(issueId, preview)).resolves.toEqual({
      id: attachmentId,
    });
    await client.attach(issueId, preview);

    for (const [, init] of request.mock.calls) {
      const { variables } = JSON.parse(String(init?.body));

      expect(variables.input).toEqual({ ...preview, issueId });
      expect(variables.input.metadata.messages.length).toBeGreaterThan(0);
    }
  });

  it.each([{}, { LINEAR_API_KEY: "one", LINEAR_ACCESS_TOKEN: "two" }])(
    "rejects missing or ambiguous credentials before any request",
    (env) => {
      const request = vi.fn<typeof fetch>();

      expect(() => new LinearAttachmentClient(env, request)).toThrow(
        "exactly one",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 500])(
    "rejects HTTP %i without exposing response content",
    async (status) => {
      const request = vi.fn<typeof fetch>(
        async () => new Response("private-response-token", { status }),
      );

      const client = new LinearAttachmentClient(
        { LINEAR_API_KEY: "test-key" },
        request,
      );

      await expect(client.attach(issueId, preview)).rejects.toThrow(/Linear/);
      await expect(client.attach(issueId, preview)).rejects.not.toThrow(
        "private-response-token",
      );
    },
  );

  it("rejects GraphQL partial success rather than claiming an attachment was saved", async () => {
    const client = new LinearAttachmentClient(
      { LINEAR_API_KEY: "test-key" },
      async () =>
        Response.json({
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: attachmentId },
            },
          },
          errors: [{ message: "private-response-token" }],
        }),
    );

    await expect(client.attach(issueId, preview)).rejects.toThrow(
      "Linear rejected",
    );
    await expect(client.attach(issueId, preview)).rejects.not.toThrow(
      "private-response-token",
    );
  });

  it.each([
    { data: { attachmentCreate: { success: false, attachment: null } } },
    { data: { attachmentCreate: { success: true, attachment: null } } },
  ])("requires an attachment ID and confirmed success", async (body) => {
    const client = new LinearAttachmentClient(
      { LINEAR_API_KEY: "test-key" },
      async () => Response.json(body),
    );

    await expect(client.attach(issueId, preview)).rejects.toThrow(
      "did not confirm",
    );
  });

  it("handles malformed responses and network errors without leaking credentials", async () => {
    const client = new LinearAttachmentClient(
      { LINEAR_API_KEY: "test-key" },
      async () => {
        throw new Error("private-request-token");
      },
    );

    const malformed = new LinearAttachmentClient(
      { LINEAR_API_KEY: "test-key" },
      async () => new Response("not JSON"),
    );

    await expect(client.issue("ENG-42")).rejects.toThrow(
      "Could not reach Linear",
    );
    await expect(client.issue("ENG-42")).rejects.not.toThrow(
      "private-request-token",
    );
    await expect(malformed.issue("ENG-42")).rejects.toThrow("invalid response");
  });
});
