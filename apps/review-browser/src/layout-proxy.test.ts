import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { init, routeEdges, setLayoutContext } from "./layout-proxy";
import type { ExtensionMessage } from "./protocol";

const issueUrl = "https://linear.app/acme/issue/ENG-12";

const context = { reviewId: "review-one", version: 3 };

const graph = { id: "root", edges: [{ id: "edge", source: "a", target: "b" }] };

const route = {
  sourcePoint: { x: 10, y: 20 },
  targetPoint: { x: 100, y: 20 },
  bendPoints: [],
  sourceSide: "east",
  targetSide: "west",
};

const response = { ok: true, value: [["edge", route]] };

const sendMessage =
  vi.fn<(message: ExtensionMessage) => Promise<typeof response>>();

let dispose = () => {};

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(response);
  vi.stubGlobal("location", { href: `${issueUrl}/the-title?detail=1` });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
});

afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

describe("content layout proxy", () => {
  it("initializes without loading WASM or contacting the worker", async () => {
    await init("https://host.invalid/libavoid.wasm");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends canonical issue and exact binding and reconstructs the route map", async () => {
    dispose = setLayoutContext(context);
    const options = { segmentPenalty: 10 };
    const routes = await routeEdges(graph, options);

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "layout:route",
      issueUrl,
      ...context,
      graph,
      options,
    });
    expect(routes).toEqual(new Map([["edge", route]]));
  });

  it("does not send unbound or navigated-away routing requests", async () => {
    await expect(routeEdges(graph)).rejects.toThrow("current bound review");
    dispose = setLayoutContext(context);
    vi.stubGlobal("location", { href: "https://linear.app/acme/issue/ENG-13" });
    await expect(routeEdges(graph)).rejects.toThrow("current bound review");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["dispose", "rebind", "navigate"])(
    "rejects in-flight results after %s",
    async (action) => {
      let resolve!: (value: typeof response) => void;
      sendMessage.mockReturnValue(
        new Promise((accept) => {
          resolve = accept;
        }),
      );
      dispose = setLayoutContext(context);
      const pending = routeEdges(graph);

      if (action === "dispose") dispose();
      else if (action === "rebind")
        dispose = setLayoutContext({ ...context, version: 4 });
      else
        vi.stubGlobal("location", {
          href: "https://linear.app/acme/issue/ENG-13",
        });

      resolve(response);
      await expect(pending).rejects.toThrow("no longer active");
    },
  );

  it("does not let an old disposer clear a replacement binding", async () => {
    const previous = setLayoutContext(context);
    dispose = setLayoutContext({ ...context, version: 4 });
    previous();
    await expect(routeEdges(graph)).resolves.toEqual(
      new Map([["edge", route]]),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ version: 4 }),
    );
  });

  it("rejects malformed worker routes without returning an empty fallback", async () => {
    dispose = setLayoutContext(context);
    sendMessage.mockResolvedValue({
      ok: true,
      value: [["edge", { ...route, sourceSide: "invalid" }]],
    });
    await expect(routeEdges(graph)).rejects.toThrow("could not route");
  });

  it("sanitizes transport failures instead of exposing error details", async () => {
    dispose = setLayoutContext(context);
    sendMessage.mockRejectedValue(
      new Error("private-token-in-transport-error"),
    );
    await expect(routeEdges(graph)).rejects.toThrow(
      "Whiteboard layout is unavailable.",
    );
  });
});
