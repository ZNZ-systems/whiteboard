import {
  type JsonValue,
  isJsonArray,
  isJsonObject,
  isStringValue,
} from "@dev.fast/json";
import {
  type ElkNode,
  type RouteResult,
  init,
  routeEdges,
} from "@mr_mint/elkjs-libavoid";
import { z } from "zod";

import { ExtensionError } from "./protocol";

const id = z.string().min(1).max(1024);

const coordinate = z.number().min(-10_000_000).max(10_000_000);

const dimension = z.number().nonnegative().max(10_000_000);

const side = z.enum(["NORTH", "SOUTH", "EAST", "WEST"]);

const port = z.object({
  id,
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  properties: z
    .object({ "port.side": side.optional(), "elk.port.side": side.optional() })
    .optional(),
});

const edge = z.object({
  id,
  source: id.optional(),
  target: id.optional(),
  sourcePort: id.optional(),
  targetPort: id.optional(),
  sources: z.array(id).length(1).optional(),
  targets: z.array(id).length(1).optional(),
});

const node: z.ZodType<ElkNode> = z.lazy(() =>
  z.object({
    id,
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
    children: z.array(node).max(1000).optional(),
    ports: z.array(port).max(8000).optional(),
    edges: z.array(edge).max(2000).optional(),
    padding: z
      .object({
        top: dimension.optional(),
        right: dimension.optional(),
        bottom: dimension.optional(),
        left: dimension.optional(),
      })
      .optional(),
  }),
);

const penalty = z.number().nonnegative().max(1_000_000);

const obstacleBufferOption = "shapeBufferDistance";

const connectedObstacleOption = "nudgeOrthogonalSegmentsConnectedToShapes";

const optionsSchema = z.strictObject({
  routingType: z.enum(["orthogonal", "polyline"]).optional(),
  segmentPenalty: penalty.optional(),
  anglePenalty: penalty.optional(),
  crossingPenalty: penalty.optional(),
  clusterCrossingPenalty: penalty.optional(),
  fixedSharedPathPenalty: penalty.optional(),
  reverseDirectionPenalty: penalty.optional(),
  portDirectionPenalty: penalty.optional(),
  [obstacleBufferOption]: penalty.optional(),
  idealNudgingDistance: penalty.optional(),
  [connectedObstacleOption]: z.boolean().optional(),
  nudgeOrthogonalTouchingColinearSegments: z.boolean().optional(),
  performUnifyingNudgingPreprocessingStep: z.boolean().optional(),
  nudgeSharedPathsWithCommonEndPoint: z.boolean().optional(),
  edgeIds: z.array(id).max(2000).optional(),
  selfLoopHandling: z.enum(["skip", "fallback"]).optional(),
});

function assertBounded(value: JsonValue) {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  let characters = 0;

  while (pending.length) {
    const entry = pending.pop()!;
    count++;

    if (entry.depth > 64 || count + pending.length > 100_000)
      throw new Error("Layout input exceeds limits");

    if (isStringValue(entry.value)) characters += entry.value.length;
    else if (isJsonArray(entry.value) || isJsonObject(entry.value)) {
      for (const [key, child] of Object.entries(entry.value)) {
        characters += key.length;
        pending.push({ value: child, depth: entry.depth + 1 });

        if (count + pending.length > 100_000 || characters > 2 * 1024 * 1024)
          throw new Error("Layout input exceeds limits");
      }
    }

    if (characters > 2 * 1024 * 1024)
      throw new Error("Layout input exceeds limits");
  }
}

export async function routeLayout(
  graph: JsonValue,
  options: JsonValue,
): Promise<Array<[string, RouteResult]>> {
  let parsedGraph: ElkNode;
  let parsedOptions: z.infer<typeof optionsSchema>;

  try {
    assertBounded(graph);
    assertBounded(options);
    parsedGraph = node.parse(graph);
    parsedOptions = optionsSchema.parse(options);
    const pending = [parsedGraph];
    let nodes = 0;
    let edges = 0;
    let ports = 0;

    while (pending.length) {
      const current = pending.pop()!;
      nodes++;
      edges += current.edges?.length ?? 0;
      ports += current.ports?.length ?? 0;

      if (nodes > 1000 || edges > 2000 || ports > 8000)
        throw new Error("Layout graph exceeds limits");

      if (
        current !== parsedGraph &&
        (current.x === undefined ||
          current.y === undefined ||
          !current.width ||
          !current.height)
      )
        throw new Error("Layout nodes must be positioned");

      if (current.children) pending.push(...current.children);
    }
  } catch {
    throw new ExtensionError(
      "Whiteboard layout input is invalid or exceeds supported limits.",
    );
  }

  try {
    await init(chrome.runtime.getURL("assets/libavoid.wasm"));

    return [...(await routeEdges(parsedGraph, parsedOptions))];
  } catch {
    throw new ExtensionError(
      "Whiteboard could not route this diagram. Reload the review and try again.",
    );
  }
}
