import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { runReviewCli } from "@review/cli-runner.js";
import { ReviewApiClient } from "@review/review-api/client.js";
import { createReviewApi } from "@review/review-api/http.js";
import { ReviewStore } from "@review/review-api/store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLinearAttachCli } from "./cli.js";

const issueId = "b59fbcea-fbca-465f-b9be-393680f15909";

const attachmentId = "1487db11-ae85-4268-bc39-4b62d4348930";

let store: ReviewStore;

let reviewId: string;

let client: ReviewApiClient;

beforeEach(async () => {
  store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const created = await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Safer writes",
      pins: {
        repositoryId: "repo",
        base: "a".repeat(40),
        head: "b".repeat(40),
      },
    },
  });

  reviewId = created.reviewId;
  await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "section",
          title: "Why",
          children: [
            { type: "markdown", markdown: "Retries reuse a stable key." },
          ],
        },
      },
    },
  });
  const app = createReviewApi(store);
  client = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (url, init) => app.request(url.replace("/reviews-api", ""), init),
  );
});

afterEach(() => store.close());

function output() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let text = "";
  let errors = "";
  stdout.on("data", (chunk) => {
    text += String(chunk);
  });
  stderr.on("data", (chunk) => {
    errors += String(chunk);
  });

  return { stdout, stderr, text: () => text, errors: () => errors };
}

function input() {
  return {
    review: reviewId,
    issue: "ENG-42",
    url: "https://reviews.example.com/safer-writes",
    env: {},
  };
}

describe("Whiteboard Linear publishing", () => {
  it("previews a saved version without Linear credentials or network requests", async () => {
    const io = output();
    const request = vi.fn<typeof fetch>();

    const code = await runLinearAttachCli(
      { ...input(), ...io, dryRun: true, version: "1" },
      { connect: async () => client, request },
    );

    const result = JSON.parse(io.text());

    expect(code).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(JSON.stringify(result.attachment.metadata)).toContain(
      "Retries reuse a stable key.",
    );
    expect(io.errors()).toContain("Trace quotes");
    expect(request).not.toHaveBeenCalled();
  });

  it("exports the selected historical version rather than mixing it with the latest", async () => {
    await store.execute({
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId,
        edit: {
          type: "insert",
          content: {
            type: "markdown",
            markdown: "Newer unpublished decision.",
          },
        },
      },
    });
    const io = output();

    expect(
      await runLinearAttachCli(
        { ...input(), ...io, dryRun: true, version: "1" },
        { connect: async () => client },
      ),
    ).toBe(0);
    expect(io.text()).not.toContain("Newer unpublished decision");
  });

  it("resolves the issue and publishes metadata without printing the token or share capability", async () => {
    const io = output();
    const requests: { url: string; body: string }[] = [];

    const request: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body) });

      return Response.json(
        requests.length === 1
          ? {
              data: {
                issue: {
                  id: issueId,
                  identifier: "ENG-42",
                  url: "https://linear.app/acme/issue/ENG-42",
                },
              },
            }
          : {
              data: {
                attachmentCreate: {
                  success: true,
                  attachment: { id: attachmentId },
                },
              },
            },
      );
    };

    const code = await runLinearAttachCli(
      {
        ...input(),
        ...io,
        json: true,
        url: "https://reviews.example.com/safer-writes#private-capability",
        env: { LINEAR_API_KEY: "private-test-key" },
      },
      { connect: async () => client, request },
    );

    expect(code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].body).variables.input.issueId).toBe(issueId);
    expect(
      JSON.parse(requests[1].body).variables.input.metadata.messages.length,
    ).toBeGreaterThan(0);
    expect(JSON.parse(io.text())).toMatchObject({
      attachmentId,
      issue: "ENG-42",
      reviewId,
      version: 1,
    });
    expect(io.text() + io.errors()).not.toContain("private-test-key");
    expect(io.text() + io.errors()).not.toContain("private-capability");
  });

  it.each([
    { url: "http://reviews.example.com/review" },
    { url: "https://user:password@reviews.example.com/review" },
    { url: "javascript:alert(1)" },
    { version: "1.5" },
    { version: "-1" },
    { version: "" },
  ])("rejects invalid publishing inputs before connecting", async (invalid) => {
    const io = output();
    const connect = vi.fn<() => Promise<ReviewApiClient>>(async () => client);

    expect(
      await runLinearAttachCli(
        { ...input(), ...io, ...invalid, dryRun: true },
        { connect },
      ),
    ).toBe(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an unavailable saved version without contacting Linear", async () => {
    const io = output();
    const request = vi.fn<typeof fetch>();

    expect(
      await runLinearAttachCli(
        { ...input(), ...io, dryRun: true, version: "999" },
        { connect: async () => client, request },
      ),
    ).toBe(1);
    expect(io.errors()).toContain("Could not read");
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a worktree snapshot even if it carries a refresh revision", async () => {
    const io = output();

    const worktreeClient = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async () =>
        Response.json({
          ...store.read(reviewId),
          target: { kind: "worktree", repositoryId: "repo" },
          pins: {
            repositoryId: "repo",
            base: "base",
            head: "head",
            worktreeRevision: "refresh",
          },
        }),
    );

    expect(
      await runLinearAttachCli(
        { ...input(), ...io, dryRun: true },
        { connect: async () => worktreeClient },
      ),
    ).toBe(1);
    expect(io.errors()).toContain("Pin this review to commits");
  });

  it("reports permission errors as failures, not successful publications", async () => {
    const io = output();

    const request = vi.fn<typeof fetch>(
      async () => new Response("private-token", { status: 403 }),
    );

    expect(
      await runLinearAttachCli(
        {
          ...input(),
          ...io,
          env: { LINEAR_API_KEY: "private-token" },
          json: true,
        },
        { connect: async () => client, request },
      ),
    ).toBe(1);
    expect(JSON.parse(io.text()).error.code).toBe("linear_attach_failed");
    expect(io.text() + io.errors()).not.toContain("private-token");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("wires the public command, including leading JSON output, without sending requests", async () => {
    const io = output();

    const code = await runReviewCli({
      ...io,
      env: {},
      argv: [
        "--json",
        "linear",
        "attach",
        "--review",
        reviewId,
        "--issue",
        "ENG-42",
        "--url",
        "https://reviews.example.com/review",
      ],
    });

    expect(code).toBe(1);
    expect(JSON.parse(io.text()).error.message).toContain("LINEAR_API_KEY");
  });
});
