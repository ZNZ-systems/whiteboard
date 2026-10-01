import { ReviewSessionProvider } from "@canvas/host/review-session";
import {
  testApiDocumentData,
  testReviewSession,
} from "@canvas/review-session-test-utils";
import type { ReviewView } from "@canvas/review-view-route";
import { captureAppOpened, captureUiEvent } from "@canvas/ui-telemetry";
import { useReviewTabTelemetry } from "@canvas/use-review-tab-telemetry";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { mountBrowserReview } from "./index";

let mounted: { dispose(): void } | undefined;

afterEach(async () => {
  await act(async () => mounted?.dispose());
  mounted = undefined;
  vi.restoreAllMocks();
});

async function waitForCanvas(assertion: () => void) {
  const deadline = Date.now() + 5000;

  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    try {
      assertion();

      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}

it("never uses page fetch or sendBeacon when a browser review mounts, switches views, or closes", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetch = vi.spyOn(window, "fetch").mockResolvedValue(Response.json({}));
  const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  const container = document.createElement("div");
  const detailContainer = document.createElement("div");
  document.body.append(container, detailContainer);

  const snapshot = testApiDocumentData([
    { id: "body", type: "markdown", markdown: "Private saved review" },
  ]).snapshot;

  const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => {
      const pathname = new URL(url).pathname;

      if (pathname.endsWith(snapshot.reviewId)) return Response.json(snapshot);

      if (pathname.endsWith("/progress"))
        return Response.json({
          complete: true,
          files: [],
          lenses: [],
          resolvedSelections: {},
        });

      return Response.json([]);
    },
  );

  await act(async () => {
    mounted = mountBrowserReview({
      container,
      detailContainer,
      reviewId: snapshot.reviewId,
      version: snapshot.version,
      request,
      wasmUrl: `${location.origin}/unused.wasm`,
    });
  });
  await waitForCanvas(() =>
    expect(container.textContent).toContain("Private saved review"),
  );
  now = 1000;
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Commits"]')!
      .click(),
  );
  await waitForCanvas(() =>
    expect(
      container
        .querySelector('button[aria-label="Commits"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  now = 2000;
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  now = 3000;
  await act(async () => mounted!.dispose());
  mounted = undefined;

  expect(fetch).not.toHaveBeenCalled();
  expect(beacon).not.toHaveBeenCalled();
  expect(
    request.mock.calls.some(([url]) =>
      new URL(url).pathname.includes("/telemetry/"),
    ),
  ).toBe(false);
});

function Telemetry({ view }: { view: ReviewView }) {
  useReviewTabTelemetry(view);

  return null;
}

it("does not install dwell tracking listeners for a browser session", async () => {
  vi.spyOn(window, "fetch").mockResolvedValue(Response.json({}));
  vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  const documentListener = vi.spyOn(document, "addEventListener");
  const windowListener = vi.spyOn(window, "addEventListener");
  const session = testReviewSession({ host: "browser" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { dispose: () => root.unmount() };

  const render = async (view: ReviewView) =>
    act(async () =>
      root.render(
        <ReviewSessionProvider session={session}>
          <Telemetry view={view} />
        </ReviewSessionProvider>,
      ),
    );

  await render("review");
  await render("diff");
  expect(
    documentListener.mock.calls.some(([type]) => type === "visibilitychange"),
  ).toBe(false);
  expect(windowListener.mock.calls.some(([type]) => type === "pagehide")).toBe(
    false,
  );
});

it("does not flush a previous desktop tracker through a newly selected browser host", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetch = vi.spyOn(window, "fetch").mockResolvedValue(Response.json({}));
  const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  const desktop = testReviewSession({ host: "desktop" });

  const browser = {
    ...testReviewSession({ host: "browser", serverUrl: "http://127.0.0.1:1" }),
    appSessionId: desktop.appSessionId,
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { dispose: () => root.unmount() };

  await act(async () =>
    root.render(
      <ReviewSessionProvider session={desktop}>
        <Telemetry view="review" />
      </ReviewSessionProvider>,
    ),
  );
  fetch.mockClear();
  beacon.mockClear();
  now = 1000;
  await act(async () =>
    root.render(
      <ReviewSessionProvider session={browser}>
        <Telemetry view="review" />
      </ReviewSessionProvider>,
    ),
  );
  now = 2000;
  await act(async () => mounted!.dispose());
  mounted = undefined;

  expect(fetch).not.toHaveBeenCalled();
  expect(beacon).not.toHaveBeenCalled();
});

it("drops direct browser UI events without using page fetch or sendBeacon", () => {
  const fetch = vi.spyOn(window, "fetch").mockResolvedValue(Response.json({}));
  const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  const browser = testReviewSession({ host: "browser" });
  captureAppOpened(browser);
  captureUiEvent(browser, "peek_opened", { via: "diagram" });
  expect(fetch).not.toHaveBeenCalled();
  expect(beacon).not.toHaveBeenCalled();
});
