import type { Writable } from "node:stream";

import { connectReviewApi } from "@review/review-api/agent-client.js";
import {
  documentSchema,
  pinsSchema,
  reviewTargetSchema,
} from "@review/review-api/document.js";
import { z } from "zod";

import { buildLinearAttachment } from "./attachment.js";
import { LinearAttachmentClient, LinearAttachmentError } from "./client.js";

const snapshotSchema = z.object({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1),
  document: documentSchema,
  pins: pinsSchema
    .extend({ worktreeRevision: z.string().optional() })
    .optional(),
  target: reviewTargetSchema.optional(),
  origin: z.object({ pullRequestUrl: z.string().optional() }).optional(),
});

export async function runLinearAttachCli(
  input: {
    review: string;
    issue: string;
    url: string;
    version?: string;
    dryRun?: boolean;
    json?: boolean;
    env?: NodeJS.ProcessEnv;
    stdout: Writable;
    stderr: Writable;
  },
  dependencies: {
    connect?: typeof connectReviewApi;
    request?: typeof fetch;
  } = {},
) {
  try {
    const options = z
      .object({
        review: z.string().trim().min(1),
        issue: z.string().trim().min(1),
        url: z.url({ protocol: /^https$/ }).refine((value) => {
          const url = new URL(value);

          return !url.username && !url.password;
        }),
        version: z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .pipe(z.number().int().nonnegative())
          .optional(),
      })
      .safeParse(input);

    if (!options.success)
      throw new LinearAttachmentError(
        "Provide a review ID, issue identifier, HTTPS review URL without username/password, and an optional nonnegative integer version.",
      );

    const env = input.env ?? process.env;

    const linear = input.dryRun
      ? undefined
      : new LinearAttachmentClient(env, dependencies.request);

    const { review, issue, url, version } = options.data;
    const query = new URLSearchParams({ format: "json", full: "true" });

    if (version !== undefined) query.set("version", String(version));

    const snapshot = await (async () => {
      try {
        const client = await (dependencies.connect ?? connectReviewApi)(env);

        return snapshotSchema.parse(
          await client.read(`/${encodeURIComponent(review)}/inspect?${query}`),
        );
      } catch {
        throw new LinearAttachmentError(
          "Could not read the saved Whiteboard review. Check the review ID/version and running desktop or --state-dir server.",
        );
      }
    })();

    if (snapshot.target?.kind === "worktree")
      throw new LinearAttachmentError(
        "Pin this review to commits before attaching it to Linear.",
      );

    const attachment = buildLinearAttachment(snapshot, url);

    input.stderr.write(
      "This exports the authored explanation, diagram summaries, code snippets/references, and supplied link to everyone with access to the Linear issue. Trace quotes and resource files are omitted. A share link may still grant access to those resources.\n",
    );

    if (!linear) {
      input.stdout.write(
        JSON.stringify({ dryRun: true, issue, attachment }, null, 2) + "\n",
      );

      return 0;
    }

    const resolvedIssue = await linear.issue(issue);
    const result = await linear.attach(resolvedIssue.id, attachment);

    input.stdout.write(
      input.json
        ? JSON.stringify({
            attachmentId: result.id,
            issue: resolvedIssue.identifier,
            issueUrl: resolvedIssue.url,
            reviewId: snapshot.reviewId,
            version: snapshot.version,
          }) + "\n"
        : `Attached Whiteboard version ${snapshot.version} to ${resolvedIssue.identifier}: ${resolvedIssue.url}\n`,
    );

    return 0;
  } catch (error) {
    const message =
      error instanceof LinearAttachmentError
        ? error.message
        : "Could not publish the Whiteboard attachment. Check the issue before retrying with the same URL.";

    if (input.json)
      input.stdout.write(
        JSON.stringify({ error: { code: "linear_attach_failed", message } }) +
          "\n",
      );
    input.stderr.write(message + "\n");

    return 1;
  }
}
