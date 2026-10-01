import { selectSource } from "@review/lens-selection.js";
import { type Block, documentSchema } from "@review/review-api/document.js";
import { describe, expect, it } from "vitest";

import {
  type LinearAttachmentSnapshot,
  buildLinearAttachment,
} from "./attachment.js";

const head = "a".repeat(40);

const base = "b".repeat(40);

const pinned = "c".repeat(40);

const reviewUrl = "https://review.example/r/review-1?version=3#section";

const snapshot: LinearAttachmentSnapshot = {
  reviewId: "review-1",
  version: 3,
  title: "Save review",
  pins: { repositoryId: "repo-1", head, base },
  origin: { pullRequestUrl: "https://github.com/acme/reviews/pull/12" },
  document: [],
};

const source = selectSource({
  side: "head",
  file: "src/save review.ts",
  fromLine: 4,
  toLine: 8,
});

function attachment(
  document: Block[],
  overrides: Partial<LinearAttachmentSnapshot> = {},
) {
  return buildLinearAttachment(
    { ...snapshot, document, ...overrides },
    reviewUrl,
  );
}

function body(
  document: Block[],
  overrides: Partial<LinearAttachmentSnapshot> = {},
) {
  return attachment(document, overrides)
    .metadata.messages.map((message) => message.body)
    .join("\n\n");
}

describe("Linear rich attachments", () => {
  it("keeps authored explanations grouped by section and preserves the full review URL", () => {
    const result = attachment([
      { type: "markdown", markdown: "Start with the problem." },
      {
        type: "section",
        title: "Storage",
        children: [
          {
            type: "markdown",
            markdown:
              "The **whole explanation**.\n\nIncluding the second paragraph.",
          },
          {
            type: "callout",
            tone: "warning",
            title: "Ordering matters",
            children: [
              {
                type: "code",
                language: "ts",
                text: "save();\nnotify();",
                caption: "Save before notifying",
              },
            ],
          },
          {
            type: "section",
            title: "Recovery",
            children: [
              { type: "markdown", markdown: "Retry the transaction." },
            ],
          },
        ],
      },
    ]);

    expect(result.url).toBe(reviewUrl);
    expect(result.title).toBe("Save review");
    expect(result.metadata.title).toBe(result.title);
    expect(result.metadata.messages.map((message) => message.subject)).toEqual([
      "",
      "Storage",
      "Storage / Recovery",
    ]);
    expect(result.metadata.messages[1]?.body).toContain(
      "The whole explanation.\n\nIncluding the second paragraph.",
    );
    expect(result.metadata.messages[1]?.body).toContain(
      "WARNING: Ordering matters",
    );
    expect(result.metadata.messages[1]?.body).toContain(
      "Save before notifying\nCode (ts):\nsave();\nnotify();",
    );
    expect(result.metadata.messages[2]?.body).toBe("Retry the transaction.");
    expect(result.metadata.attributes).toContainEqual({
      name: "Version",
      value: "3",
    });
    expect(result.metadata.attributes).toContainEqual({
      name: "Base commit",
      value: base,
    });
    expect(result.metadata.attributes).toContainEqual({
      name: "Head commit",
      value: head,
    });
    expect(result.metadata.attributes).toContainEqual({
      name: "Pull request",
      value: snapshot.origin!.pullRequestUrl,
    });
  });

  it("uses a safe nonempty title and bounds lengthy titles", () => {
    const empty = attachment([], { title: "<script>ignored</script>" });
    const lengthy = attachment([], { title: "Long title ".repeat(100) });

    expect(empty.title).toBe("Whiteboard review");
    expect(empty.metadata.title).toBe(empty.title);
    expect(lengthy.title.length).toBeLessThanOrEqual(200);
    expect(lengthy.title).toMatch(/^Long title .*…$/);
    expect(lengthy.metadata.title).toBe(lengthy.title);
  });

  it("turns Markdown prose, lists, tables, and reference links into readable text", () => {
    const result = body([
      {
        type: "markdown",
        markdown: [
          "## Constraints",
          "",
          "1. Keep *existing* data.",
          "2. Use `save()`.",
          "",
          "| Column | Meaning |",
          "| --- | --- |",
          "| version | A counter |",
          "",
          "Read [the guide][guide] or <mailto:help@example.com>.",
          "",
          "[guide]: https://example.com/guide",
        ].join("\n"),
      },
    ]);

    expect(result).toContain("Constraints");
    expect(result).toContain("1. Keep existing data.\n2. Use save().");
    expect(result).toContain("Column | Meaning");
    expect(result).toContain("version | A counter");
    expect(result).toContain("the guide (https://example.com/guide)");
    expect(result).toContain("mailto:help@example.com");
    expect(result).not.toContain("[guide]:");
  });

  it("pins source hyperlinks and selections to the correct commits and encodes paths", () => {
    const result = body([
      {
        type: "markdown",
        markdown:
          "[Old code][old]\n\n[old]: review-source:base/src/save%20review.ts#L2-L3",
      },
      { type: "code_peek", source },
      {
        type: "markdown",
        markdown: "[Pinned](review-source:head/src/pinned.ts#L9)",
        pins: { repositoryId: "repo-1", head: pinned },
      },
      {
        type: "code_peek",
        source: { ...source, pins: { repositoryId: "repo-1", head: pinned } },
      },
    ]);

    expect(result).toContain(
      `https://github.com/acme/reviews/blob/${base}/src/save%20review.ts#L2-L3`,
    );
    expect(result).toContain(
      `https://github.com/acme/reviews/blob/${head}/src/save%20review.ts#L4-L8`,
    );
    expect(result).toContain(
      `https://github.com/acme/reviews/blob/${pinned}/src/pinned.ts#L9`,
    );
    expect(result).toContain(
      `https://github.com/acme/reviews/blob/${pinned}/src/save%20review.ts#L4-L8`,
    );
    expect(result).not.toContain("review-source:");
  });

  it("keeps cross-side diff endpoints separate rather than inventing a range", () => {
    const result = body([
      {
        type: "code_peek",
        source: { ...source, start: { side: "base", line: 2 } },
      },
    ]);

    expect(result).toContain(`/blob/${base}/src/save%20review.ts#L2`);
    expect(result).toContain(`/blob/${head}/src/save%20review.ts#L8`);
    expect(result).not.toContain("#L2-L8");
  });

  it("uses explicit head pins as the base when that reference has no base pin", () => {
    const pins = { repositoryId: "repo-1", head: pinned };

    const result = body([
      {
        type: "markdown",
        markdown: "[Base](review-source:base/src/base.ts#L3)",
        pins,
      },
      {
        type: "code_peek",
        source: {
          ...source,
          start: { side: "base", line: 4 },
          end: { side: "base", line: 8 },
          pins,
        },
      },
    ]);

    expect(result).toContain(`/blob/${pinned}/src/base.ts#L3`);
    expect(result).toContain(`/blob/${pinned}/src/save%20review.ts#L4-L8`);
    expect(result).not.toContain(`/blob/${base}/`);
  });

  it("does not fabricate links for foreign, unknown, or mutable source locations", () => {
    const foreign = body([
      {
        type: "code_peek",
        source: {
          ...source,
          pins: { repositoryId: "other-repo", head: pinned },
        },
      },
      {
        type: "markdown",
        markdown: "[Other](review-source:head/src/other.ts#L1)",
        pins: { repositoryId: "other-repo", head: pinned },
      },
    ]);

    expect(foreign).toContain("src/save review.ts:4-8");
    expect(foreign).toContain("src/other.ts:1");
    expect(foreign).toContain(pinned);
    expect(foreign).not.toContain("github.com");

    for (const overrides of [
      { origin: undefined },
      { origin: { pullRequestUrl: "javascript:alert(1)" } },
      { pins: undefined },
      { pins: { repositoryId: "repo-1", head: "main", base: "main~1" } },
    ]) {
      const result = body([{ type: "code_peek", source }], overrides);

      expect(result).toContain("src/save review.ts:4-8");
      expect(result).not.toContain("/blob/");
    }
  });

  it("supports canonical GitHub Enterprise origins without redirecting to github.com", () => {
    const result = body([{ type: "code_peek", source }], {
      origin: {
        pullRequestUrl: "https://git.acme.example/acme/reviews/pull/12",
      },
    });

    expect(result).toContain(
      `https://git.acme.example/acme/reviews/blob/${head}/`,
    );
    expect(result).not.toContain("github.com");
  });

  it("renders sequence and flow relationships with their authored explanations", () => {
    const result = body(
      documentSchema.parse([
        {
          type: "sequence",
          title: "Save request",
          actors: { c: "Client", s: "Server" },
          steps: [
            {
              from: "c",
              to: "s",
              label: "Submit",
              explanation: "Validate before saving.",
            },
            {
              from: "s",
              to: "c",
              label: "Result",
              style: "return",
              code: { language: "json", text: "true" },
            },
          ],
        },
        {
          type: "flow_diagram",
          title: "Decision",
          description: "Reject invalid requests.",
          nodes: [
            {
              key: "a",
              label: "Validate",
              kind: "decision",
              description: "Check required fields.",
              attachments: [{ label: "Implementation", sources: [source] }],
            },
            { key: "b", label: "Save", attachments: [] },
          ],
          edges: [{ from: "a", to: "b", label: "valid" }],
        },
      ]),
    );

    expect(result).toContain("Client → Server: Submit (call)");
    expect(result).toContain("Validate before saving.");
    expect(result).toContain("Server → Client: Result (return)");
    expect(result).toContain("Code (json):\ntrue");
    expect(result).toContain("Reject invalid requests.");
    expect(result).toContain("Check required fields.");
    expect(result).toContain("Validate → Save: valid");
    expect(result).toContain(`/blob/${head}/src/save%20review.ts#L4-L8`);
  });

  it("preserves call stack parent relationships and each frame's source side", () => {
    const result = body([
      {
        type: "call_stack_diff",
        title: "Save path",
        base: [
          {
            label: "Old entry",
            source: {
              ...source,
              start: { side: "base", line: 4 },
              end: { side: "base", line: 8 },
            },
          },
        ],
        head: [
          { key: "root", label: "Entry", source },
          {
            key: "child",
            parentKey: "root",
            label: "Store",
            source,
            via: { kind: "queue", reason: "Run after validation." },
            callSite: source,
            contextSources: [source],
          },
          { key: "other", parentKey: null, label: "Independent", source },
        ],
      },
    ]);

    expect(result).toContain("BASE:");
    expect(result).toContain("HEAD:");
    expect(result).toContain("Entry → Store");
    expect(result).not.toContain("Store → Independent");
    expect(result).toContain("queue: Run after validation.");
    expect(result).toContain("Call site:");
    expect(result).toContain("Context:");
    expect(result).toContain(`/blob/${base}/`);
    expect(result).toContain(`/blob/${head}/`);
  });

  it("describes database reads, writes, fields, and authored operation details", () => {
    const result = body([
      {
        type: "database_lens",
        title: "Persistence",
        actors: { s: { label: "Server", softwareMapPath: "app/server" } },
        stores: {
          db: {
            label: "Database",
            storage: "relational",
            collections: {
              reviews: {
                label: "Reviews",
                fields: {
                  id: {
                    label: "Review ID",
                    dataType: "text",
                    primaryKey: true,
                  },
                  owner: {
                    label: "Owner",
                    dataType: "text",
                    nullable: true,
                    references: {
                      store: "db",
                      collection: "users",
                      field: "id",
                    },
                  },
                },
              },
            },
          },
        },
        useCases: [
          {
            label: "Save",
            summary: "Keep the reviewed content.",
            operations: [
              {
                kind: "read",
                store: "db",
                collection: "reviews",
                actor: "s",
                label: "Find version",
                source,
              },
              {
                kind: "write",
                store: "db",
                collection: "reviews",
                actor: "s",
                label: "Persist version",
                detail: "Commit before notifying.",
                source,
              },
            ],
          },
        ],
      },
    ]);

    expect(result).toContain(
      "Server reads from Database.Reviews: Find version",
    );
    expect(result).toContain(
      "Server writes to Database.Reviews: Persist version",
    );
    expect(result).toContain("Keep the reviewed content.");
    expect(result).toContain("Commit before notifying.");
    expect(result).toContain("id: Review ID (text, primary key)");
    expect(result).toContain("owner: Owner (text, nullable) → db.users.id");
  });

  it("omits trace quote bodies, inline quote labels, and unrequested raw snapshot data", () => {
    const privateSnapshot = {
      ...snapshot,
      traces: [{ text: "RAW_CONVERSATION_SECRET" }],
      document: documentSchema.parse([
        {
          type: "tutorial",
          kind: "conversation",
          conversation: {
            version: 1,
            title: "PRIVATE_CONVERSATION_TITLE",
            messages: [
              { role: "user", body: "PRIVATE_USER_MESSAGE" },
              { role: "assistant", body: "PRIVATE_ASSISTANT_MESSAGE" },
            ],
          },
        },
        {
          type: "trace_quote",
          traceId: "TRACE_SECRET",
          eventId: "EVENT_SECRET",
          text: "PRIVATE_QUOTE",
        },
        {
          type: "markdown",
          markdown:
            "The reason: [PRIVATE_INLINE_QUOTE][quote]\n\n[quote]: review-trace:TRACE_SECRET#EVENT_SECRET",
        },
        {
          type: "callout",
          children: [
            {
              type: "trace_quote",
              traceId: "NESTED_TRACE",
              eventId: "NESTED_EVENT",
              text: "NESTED_SECRET",
            },
          ],
        },
        {
          type: "image",
          assetId: "PRIVATE_ASSET",
          alt: "Save dialog",
          caption: "After saving",
        },
        {
          type: "software_map",
          mapVersionId: "PRIVATE_MAP",
          focusElementId: "storage",
        },
      ]),
    };

    const result = buildLinearAttachment(privateSnapshot, reviewUrl);
    const exported = JSON.stringify(result);

    for (const secret of [
      "RAW_CONVERSATION_SECRET",
      "TRACE_SECRET",
      "EVENT_SECRET",
      "PRIVATE_QUOTE",
      "PRIVATE_INLINE_QUOTE",
      "NESTED_SECRET",
      "NESTED_TRACE",
      "NESTED_EVENT",
      "PRIVATE_ASSET",
      "PRIVATE_MAP",
      "PRIVATE_CONVERSATION_TITLE",
      "PRIVATE_USER_MESSAGE",
      "PRIVATE_ASSISTANT_MESSAGE",
    ])
      expect(exported).not.toContain(secret);

    expect(exported).toContain("Trace quote omitted for privacy");
    expect(exported).toContain("Conversation omitted for privacy");
    expect(exported).toContain("Save dialog (not embedded)");
    expect(exported).toContain("After saving");
    expect(exported).toContain("Map resources are not included");
  });

  it("drops HTML, unsafe link destinations, and remote image URLs without losing nearby prose", () => {
    const result = body([
      {
        type: "markdown",
        markdown: [
          "Before **safe text** [run](javascript:alert%281%29) [local](file:///secret) [custom](custom://danger).",
          "",
          "<script>UNSAFE_SCRIPT</script>",
          "",
          '<iframe src="https://evil.example/frame"></iframe>',
          "",
          "![Useful diagram](https://evil.example/tracking.png)",
          "",
          "![Reference image][img]",
          "",
          "[img]: https://evil.example/other.png",
          "",
          "After [documentation](https://example.com/docs).",
        ].join("\n"),
      },
      {
        type: "code",
        language: "html",
        text: "<script>code example</script>\n![image](https://evil.example/code.png)",
      },
    ]);

    expect(result).toContain("Before safe text run local custom.");
    expect(result).toContain("Image: Useful diagram (not embedded)");
    expect(result).toContain("Image: Reference image (not embedded)");
    expect(result).toContain("After documentation (https://example.com/docs).");
    expect(result).not.toMatch(/<script|<iframe|javascript:|file:|custom:|!\[/);
    expect(result).not.toContain("UNSAFE_SCRIPT");
    expect(result).not.toContain("tracking.png");
    expect(result).not.toContain("other.png");
  });

  it("tolerates malformed source URLs and never turns path traversal into GitHub links", () => {
    const result = body([
      {
        type: "markdown",
        markdown: [
          "[broken](review-source:head/%ZZ.ts#L1)",
          "[missing](review-source:main/file.ts)",
          "[invalid](review-source:head/file.ts#L9-L2)",
          "[escape](review-source:head/../secret#L1)",
        ].join("\n"),
      },
    ]);

    expect(result).toContain("broken (source location unavailable)");
    expect(result).toContain("../secret:1");
    expect(result).not.toContain("/blob/");
    expect(result).not.toContain("review-source:");
  });

  it.each(["body", "subjects", "many sections"])(
    "keeps all message text below 10k with an explicit notice when %s exceed the limit",
    (kind) => {
      const document: Block[] =
        kind === "body"
          ? [{ type: "markdown", markdown: "Long explanation. ".repeat(1_000) }]
          : Array.from({ length: kind === "subjects" ? 1 : 600 }, () => ({
              type: "section",
              title:
                kind === "subjects"
                  ? "Subject ".repeat(2_000)
                  : "Section title",
              children: [
                { type: "markdown", markdown: "An authored explanation." },
              ],
            }));

      const messages = attachment(document).metadata.messages;

      const length = messages.reduce(
        (total, message) =>
          total +
          (message.subject?.length ?? 0) +
          (message.body?.length ?? 0) +
          (message.timestamp?.length ?? 0),
        0,
      );

      expect(length).toBeLessThan(10_000);
      expect(messages.at(-1)?.body).toContain("Preview truncated");
      expect(messages.at(-1)?.body).toContain("Open the attached review");
    },
  );

  it("does not truncate short reviews and provides a useful empty-review preview", () => {
    const text = "A complete explanation.";

    expect(body([{ type: "markdown", markdown: text }])).toBe(text);
    expect(body([])).toContain("No authored content");
  });
});
