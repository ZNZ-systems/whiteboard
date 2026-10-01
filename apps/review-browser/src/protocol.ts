import { z } from "zod";

export const reviewIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);

export const versionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export function canonicalIssue(value: string): string | null {
  if (
    value.length > 4096 ||
    !value.startsWith("https://linear.app/") ||
    /[\\\s]/.test(value)
  )
    return null;

  try {
    const url = new URL(value);

    if (
      value.slice("https://linear.app".length).split(/[?#]/)[0] !== url.pathname
    )
      return null;

    const match =
      /^\/([a-z0-9][a-z0-9-]*)\/issue\/([A-Z][A-Z0-9]*-[1-9][0-9]*)(?:\/[^/%]+)?\/?$/.exec(
        url.pathname,
      );

    if (
      url.origin !== "https://linear.app" ||
      url.username ||
      url.password ||
      !match
    )
      return null;

    return `https://linear.app/${match[1]}/issue/${match[2]}`;
  } catch {
    return null;
  }
}

export const bindingSchema = z.strictObject({
  issueUrl: z.string().refine((value) => canonicalIssue(value) === value),
  reviewId: reviewIdSchema,
  version: versionSchema,
  title: z.string().max(1000),
});

export type Binding = z.infer<typeof bindingSchema>;

export const catalogEntrySchema = z.object({
  reviewId: reviewIdSchema,
  version: versionSchema,
  title: z.string().max(1000),
  repositoryName: z.string().max(1000).optional(),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

const issue = { issueUrl: z.string().max(4096) };

const bound = { ...issue, reviewId: reviewIdSchema, version: versionSchema };

export const messageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("review:status"), ...issue }),
  z.strictObject({ type: z.literal("review:options"), ...issue }),
  z.strictObject({ type: z.literal("review:refresh"), ...bound }),
  z.strictObject({
    type: z.literal("layout:route"),
    ...bound,
    graph: z.json(),
    options: z.json(),
  }),
  z.strictObject({
    type: z.literal("review:request"),
    ...bound,
    path: z.string().min(1).max(8192),
    method: z.literal("GET"),
  }),
  z.strictObject({ type: z.literal("options:status") }),
  z.strictObject({
    type: z.literal("options:connect"),
    source: z.string().max(16384),
  }),
  z.strictObject({ type: z.literal("options:disconnect") }),
  z.strictObject({ type: z.literal("options:catalog") }),
  z.strictObject({ type: z.literal("options:bind"), ...bound }),
  z.strictObject({ type: z.literal("options:unbind"), ...issue }),
]);

export type ExtensionMessage = z.infer<typeof messageSchema>;

export const statusSchema = z.strictObject({
  connected: z.boolean(),
  binding: bindingSchema.nullable(),
});

export const optionsStatusSchema = z.strictObject({
  connected: z.boolean(),
  bindings: z.array(bindingSchema),
});

export const responseSchema = z.strictObject({
  status: z.number().int().min(200).max(599),
  contentType: z.string().max(128),
  encoding: z.enum(["text", "base64"]),
  body: z.string().max(12 * 1024 * 1024),
});

export type TransportResponse = z.infer<typeof responseSchema>;

export class ExtensionError extends Error {}

export async function send<T extends z.ZodType>(
  message: ExtensionMessage,
  schema: T,
): Promise<z.infer<T>> {
  let raw;

  try {
    raw = await chrome.runtime.sendMessage(message);
  } catch {
    throw new ExtensionError(
      "Whiteboard extension unavailable. Reload this page and try again.",
    );
  }

  const result = z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: z.json() }),
      z.object({ ok: z.literal(false), error: z.string().max(300) }),
    ])
    .safeParse(raw);

  if (!result.success)
    throw new ExtensionError("Whiteboard returned an invalid response.");

  if (!result.data.ok) throw new ExtensionError(result.data.error);
  const value = schema.safeParse(result.data.value);

  if (!value.success)
    throw new ExtensionError("Whiteboard returned an invalid response.");

  return value.data;
}
