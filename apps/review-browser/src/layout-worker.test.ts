import { createRequire } from "node:module";
import path from "node:path";

import type { JsonValue } from "@dev.fast/json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { routeLayout } from "./layout-worker";

const require = createRequire(import.meta.url);

const wasmPath = path.join(
  path.dirname(require.resolve("libavoid-js")),
  "libavoid.wasm",
);

const getURL = vi.fn<(asset: string) => string>(() => wasmPath);

const obstacleBufferOption = "shapeBufferDistance";

const graph = {
  id: "root",
  children: [
    { id: "a", x: 0, y: 0, width: 40, height: 40 },
    { id: "b", x: 100, y: 0, width: 40, height: 40 },
  ],
  edges: [{ id: "edge", source: "a", target: "b" }],
};

beforeEach(() => {
  getURL.mockClear();
  vi.stubGlobal("chrome", { runtime: { getURL } });
});

afterEach(() => vi.unstubAllGlobals());

describe("extension-owned layout worker", () => {
  it("initializes the packaged WASM and returns real router entries", async () => {
    const routes = await routeLayout(graph, {
      routingType: "orthogonal",
      segmentPenalty: 10,
    });

    expect(getURL).toHaveBeenCalledExactlyOnceWith("assets/libavoid.wasm");
    expect(routes).toHaveLength(1);
    expect(routes[0][0]).toBe("edge");
    expect(routes[0][1].sourcePoint.x).toBe(40);
    expect(routes[0][1].targetPoint.x).toBe(100);
    expect(routes[0][1].sourcePoint.y).toBe(routes[0][1].targetPoint.y);
    expect(routes[0][1].sourceSide).toBe("east");
    expect(routes[0][1].targetSide).toBe("west");
  });

  it.each<JsonValue>([
    null,
    { id: "root", children: [{ id: "unpositioned", width: 40, height: 40 }] },
    { ...graph, children: [{ ...graph.children[0], width: -1 }] },
    { ...graph, children: [{ ...graph.children[0], x: 20_000_000 }] },
    {
      id: "root",
      children: Array.from({ length: 1001 }, (_, index) => ({
        ...graph.children[0],
        id: String(index),
      })),
    },
  ])(
    "rejects invalid or oversized graphs before starting WASM %#",
    async (input) => {
      await expect(routeLayout(input, {})).rejects.toThrow(
        "invalid or exceeds supported limits",
      );
      expect(getURL).not.toHaveBeenCalled();
    },
  );

  it("rejects excessive nesting before recursive graph parsing", async () => {
    let nested: JsonValue = { id: "leaf" };

    for (let index = 0; index < 100; index++)
      nested = { id: String(index), children: [nested] };

    await expect(routeLayout(nested, {})).rejects.toThrow(
      "invalid or exceeds supported limits",
    );
    expect(getURL).not.toHaveBeenCalled();
  });

  it.each<JsonValue>([
    { routingType: "unsupported" },
    { [obstacleBufferOption]: -1 },
    { segmentPenalty: 2_000_000 },
    { unexpected: true },
  ])("rejects unsupported options before starting WASM %#", async (options) => {
    await expect(routeLayout(graph, options)).rejects.toThrow(
      "invalid or exceeds supported limits",
    );
    expect(getURL).not.toHaveBeenCalled();
  });

  it("sanitizes real routing errors without suppressing failures", async () => {
    const invalid = {
      ...graph,
      edges: [
        {
          id: "private-edge-detail",
          source: "private-source-detail",
          target: "b",
        },
      ],
    };

    await expect(routeLayout(invalid, {})).rejects.toThrow(
      "Whiteboard could not route this diagram. Reload the review and try again.",
    );
  });
});
