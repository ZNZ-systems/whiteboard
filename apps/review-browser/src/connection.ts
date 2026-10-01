import { z } from "zod";

import {
  type Binding,
  ExtensionError,
  type TransportResponse,
} from "./protocol";

export const discoverySchema = z.strictObject({
  version: z.literal(1),
  instanceId: z.uuid(),
  url: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/)
    .refine((value) => {
      try {
        const url = new URL(value);

        return (
          Number(url.port) > 0 &&
          Number(url.port) <= 65535 &&
          url.origin === value.replace(/\/$/, "")
        );
      } catch {
        return false;
      }
    })
    .transform((value) => value.replace(/\/$/, "")),
  serverPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
});

export type Connection = z.infer<typeof discoverySchema>;

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function parseDiscovery(source: string): Connection {
  try {
    if (source.length > 16384) throw new Error();

    return discoverySchema.parse(JSON.parse(source));
  } catch {
    throw new ExtensionError(
      "Invalid server.json. Start Whiteboard's local server and import its discovery file.",
    );
  }
}

export async function localRequest(
  connection: Connection,
  path: string,
  request: typeof fetch = fetch,
): Promise<TransportResponse> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);

  try {
    const response = await request(connection.url + path, {
      method: "GET",
      headers: { "x-review-token": connection.token },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: abort.signal,
    });

    if (
      response.redirected ||
      response.status < 200 ||
      response.status >= 300
    ) {
      await response.body?.cancel();
      throw new ExtensionError(
        response.status === 401 || response.status === 403
          ? "Whiteboard connection expired. Import the current server.json in extension settings."
          : "Whiteboard could not read this saved review. Check the local server and reconnect.",
      );
    }

    const declared = response.headers.get("content-length");

    if (
      declared &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
    ) {
      await response.body?.cancel();
      throw new ExtensionError("Whiteboard response exceeds the 8 MiB limit.");
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();

    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) break;
          length += chunk.value.byteLength;

          if (length > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ExtensionError(
              "Whiteboard response exceeds the 8 MiB limit.",
            );
          }

          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const contentType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "application/octet-stream";

    if (
      contentType.length > 128 ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType)
    )
      throw new ExtensionError("Invalid Whiteboard content type.");

    if (
      contentType === "application/json" ||
      contentType === "application/x-ndjson" ||
      contentType.startsWith("text/")
    ) {
      return {
        status: response.status,
        contentType,
        encoding: "text",
        body: new TextDecoder().decode(bytes),
      };
    }

    let binary = "";

    for (let index = 0; index < bytes.length; index += 8192)
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));

    return {
      status: response.status,
      contentType,
      encoding: "base64",
      body: btoa(binary),
    };
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(
      "Cannot reach Whiteboard. Run whiteboard server start, then reconnect in extension settings.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function probeConnection(
  connection: Connection,
  request: typeof fetch = fetch,
) {
  const result = await localRequest(connection, "/health", request);

  try {
    const health = z
      .object({ ok: z.literal(true), instanceId: z.uuid() })
      .parse(JSON.parse(result.body));

    if (health.instanceId !== connection.instanceId) throw new Error();
  } catch {
    throw new ExtensionError(
      "This server.json belongs to a different Whiteboard server. Import the current file.",
    );
  }
}

const queryKeys = new Map<string, Set<string>>([
  ["", new Set(["version", "full", "targetId"])],
  ["progress", new Set(["version", "mode", "wait"])],
  [
    "file",
    new Set([
      "version",
      "side",
      "file",
      "binary",
      "repositoryId",
      "base",
      "head",
      "commit",
    ]),
  ],
  [
    "diff",
    new Set([
      "version",
      "side",
      "file",
      "paths",
      "format",
      "context",
      "maxBytes",
      "repositoryId",
      "base",
      "head",
      "commit",
    ]),
  ],
  [
    "structural-diff",
    new Set(["version", "file", "repositoryId", "base", "head", "commit"]),
  ],
  [
    "tree",
    new Set([
      "version",
      "side",
      "path",
      "repositoryId",
      "base",
      "head",
      "commit",
    ]),
  ],
  ["commits", new Set(["version"])],
  ["history", new Set(["version"])],
  ["resources", new Set(["version"])],
  ["maps", new Set(["version"])],
]);

export function authorizePath(path: string, binding: Binding) {
  const deny = () =>
    new ExtensionError(
      "Only read-only requests for this bound saved review are allowed.",
    );

  if (
    path.length > 8192 ||
    !path.startsWith("/reviews-api/") ||
    /[\\#\x00-\x20]/.test(path)
  )
    throw deny();
  const url = new URL(path, "http://extension.invalid");
  const prefix = `/reviews-api/${binding.reviewId}`;

  if (
    url.origin !== "http://extension.invalid" ||
    (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/"))
  )
    throw deny();

  if (path.split("?")[0] !== url.pathname) throw deny();
  const suffix = url.pathname.slice(prefix.length).replace(/^\//, "");
  const parts = suffix.split("/");
  const endpoint = parts[0] ?? "";
  const keys = queryKeys.get(endpoint);
  const resourceId = parts[1];

  if (
    !keys ||
    (endpoint === "maps" || endpoint === "resources"
      ? parts.length !== 2 ||
        !resourceId ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(resourceId)
      : parts.length !== 1)
  )
    throw deny();
  const seen = new Set<string>();

  for (const [key, value] of url.searchParams) {
    if (
      !keys.has(key) ||
      (seen.has(key) && key !== "paths") ||
      value.length > 2048 ||
      /[\x00-\x1f]/.test(value)
    )
      throw deny();
    seen.add(key);

    if (key === "version" && value !== String(binding.version)) throw deny();

    if (key === "full" && value !== "true") throw deny();

    if (key === "side" && value !== "base" && value !== "head") throw deny();

    if (
      (key === "file" || key === "path" || key === "paths") &&
      (value.startsWith("/") ||
        value.includes("\\") ||
        value.split("/").includes(".."))
    )
      throw deny();
  }

  url.searchParams.set("version", String(binding.version));

  return { path: url.pathname + url.search, endpoint, resourceId };
}
