import { type JsonValue, parseJsonText } from "@dev.fast/json";
import { z } from "zod";

import type { buildLinearAttachment } from "./attachment.js";

export class LinearAttachmentError extends Error {}

const issueSchema = z.object({
  data: z.object({
    issue: z.object({
      id: z.uuid(),
      identifier: z.string().min(1),
      url: z.url(),
    }),
  }),
});

const attachmentSchema = z.object({
  data: z.object({
    attachmentCreate: z.object({
      success: z.literal(true),
      attachment: z.object({ id: z.uuid() }),
    }),
  }),
});

export class LinearAttachmentClient {
  private readonly authorization: string;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly request: typeof fetch = fetch,
  ) {
    const apiKey = env.LINEAR_API_KEY?.trim();
    const accessToken = env.LINEAR_ACCESS_TOKEN?.trim();

    if ((!apiKey && !accessToken) || (apiKey && accessToken))
      throw new LinearAttachmentError(
        "Set exactly one of LINEAR_API_KEY or LINEAR_ACCESS_TOKEN.",
      );

    this.authorization = apiKey ?? `Bearer ${accessToken}`;
  }

  async issue(identifier: string) {
    const result = issueSchema.safeParse(
      await this.graphql(
        "query WhiteboardIssue($id: String!) { issue(id: $id) { id identifier url } }",
        { id: identifier },
      ),
    );

    if (!result.success)
      throw new LinearAttachmentError(
        "Linear did not return the issue. Check its identifier and your access.",
      );

    return result.data.data.issue;
  }

  async attach(
    issueId: string,
    attachment: ReturnType<typeof buildLinearAttachment>,
  ) {
    const result = attachmentSchema.safeParse(
      await this.graphql(
        "mutation WhiteboardAttachment($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id } } }",
        { input: { ...attachment, issueId } },
      ),
    );

    if (!result.success)
      throw new LinearAttachmentError(
        "Linear did not confirm the attachment. Check the issue before retrying with the same URL.",
      );

    return result.data.data.attachmentCreate.attachment;
  }

  private async graphql(
    query: string,
    variables:
      | { id: string }
      | {
          input: ReturnType<typeof buildLinearAttachment> & { issueId: string };
        },
  ) {
    let response: Response;

    try {
      response = await this.request("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          authorization: this.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new LinearAttachmentError(
        "Could not reach Linear. Check the issue before retrying with the same URL; the request may have succeeded.",
      );
    }

    if (response.status === 401 || response.status === 403)
      throw new LinearAttachmentError(
        "Linear denied access. Check the token, its permissions, and access to the issue's team.",
      );

    if (response.status === 429)
      throw new LinearAttachmentError(
        "Linear rate limit reached. Wait before retrying with the same URL.",
      );

    if (!response.ok)
      throw new LinearAttachmentError(
        `Linear returned HTTP ${response.status}. Check the issue before retrying with the same URL.`,
      );

    let body: JsonValue;

    try {
      body = parseJsonText(await response.text());
    } catch {
      throw new LinearAttachmentError("Linear returned an invalid response.");
    }

    const envelope = z
      .object({ errors: z.array(z.unknown()).optional() })
      .safeParse(body);

    if (!envelope.success)
      throw new LinearAttachmentError("Linear returned an invalid response.");

    if (envelope.data.errors?.length)
      throw new LinearAttachmentError(
        "Linear rejected the request. Check the issue identifier, token permissions, and attachment content before retrying with the same URL.",
      );

    return body;
  }
}
