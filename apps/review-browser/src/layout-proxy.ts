import type {
  ElkGraph,
  LibavoidRoutingOptions,
  RouteResult,
} from "@mr_mint/elkjs-libavoid";
import { z } from "zod";

import {
  ExtensionError,
  canonicalIssue,
  reviewIdSchema,
  versionSchema,
} from "./protocol";

interface LayoutContext {
  reviewId: string;
  version: number;
}

let active: (LayoutContext & { issueUrl: string; generation: number }) | null =
  null;

let generation = 0;

const point = z.object({ x: z.number(), y: z.number() });

const side = z.enum(["north", "south", "east", "west"]);

const responseSchema = z.object({
  ok: z.literal(true),
  value: z
    .array(
      z.tuple([
        z.string().min(1).max(1024),
        z.object({
          sourcePoint: point,
          targetPoint: point,
          bendPoints: z.array(point).max(10_000),
          sourceSide: side,
          targetSide: side,
        }),
      ]),
    )
    .max(2000),
});

export function setLayoutContext(context: LayoutContext): () => void {
  generation++;
  active = null;
  const issueUrl = canonicalIssue(location.href);

  if (
    !issueUrl ||
    !reviewIdSchema.safeParse(context.reviewId).success ||
    !versionSchema.safeParse(context.version).success
  )
    throw new ExtensionError(
      "Whiteboard layout requires a bound Linear issue.",
    );

  const current = { ...context, issueUrl, generation };
  active = current;

  return () => {
    if (active !== current) return;
    generation++;
    active = null;
  };
}

export async function init(_wasmUrl?: string): Promise<void> {}

export async function routeEdges(
  graph: ElkGraph,
  options: LibavoidRoutingOptions = {},
): Promise<Map<string, RouteResult>> {
  const context = active;

  if (!context || canonicalIssue(location.href) !== context.issueUrl)
    throw new ExtensionError(
      "Whiteboard layout requires the current bound review.",
    );

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "layout:route",
      issueUrl: context.issueUrl,
      reviewId: context.reviewId,
      version: context.version,
      graph,
      options,
    });
  } catch {
    throw new ExtensionError(
      "Whiteboard layout is unavailable. Reload the review and try again.",
    );
  }

  if (
    active !== context ||
    generation !== context.generation ||
    canonicalIssue(location.href) !== context.issueUrl
  )
    throw new ExtensionError(
      "Whiteboard discarded a layout for a review that is no longer active.",
    );

  const result = responseSchema.safeParse(response);

  if (!result.success)
    throw new ExtensionError(
      "Whiteboard could not route this diagram. Reload the review and try again.",
    );

  const routes = new Map(result.data.value);

  if (routes.size !== result.data.value.length)
    throw new ExtensionError("Whiteboard returned an invalid diagram layout.");

  return routes;
}
