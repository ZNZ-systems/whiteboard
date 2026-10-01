import { mountReviewCanvas } from "@canvas/desktop-entry";
import { ReviewSessionProvider } from "@canvas/host/review-session";
import {
  testApiDocumentData,
  testReviewSession,
} from "@canvas/review-session-test-utils";
import { ViewedButton } from "@canvas/viewed-button";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { createBrowserReviewBridge } from "./bridge";
import { mountBrowserReview } from "./index";

const disposables: { dispose(): void }[] = [];

afterEach(async () => {
  await act(async () => {
    for (const item of disposables.splice(0)) item.dispose();
  });
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

function fixture() {
  const snapshot = {
    ...testApiDocumentData([
      {
        id: "notes",
        type: "markdown",
        markdown: "- [ ] Keep the saved review immutable",
      },
    ]).snapshot,
    version: 7,
    title: "Saved review controls",
    origin: {
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/example/repo/pull/12",
    },
  };

  const container = document.createElement("div");
  container.style.width = "1000px";
  container.style.height = "700px";
  const detailContainer = document.createElement("div");
  document.body.append(container, detailContainer);
  const requests: URL[] = [];

  const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => {
      const target = new URL(url);
      requests.push(target);

      if (target.pathname.endsWith(snapshot.reviewId))
        return Response.json(snapshot);

      if (target.pathname.endsWith("/progress"))
        return Response.json({
          complete: true,
          files: [],
          lenses: [],
          resolvedSelections: {},
        });

      return Response.json([]);
    },
  );

  return {
    container,
    detailContainer,
    reviewId: snapshot.reviewId,
    version: 7,
    wasmUrl: `${location.origin}/unused.wasm`,
    request,
    requests,
  };
}

it("shows a saved read-only banner and omits desktop actions while preserving view navigation", async () => {
  const options = fixture();
  await act(async () => disposables.push(mountBrowserReview(options)));
  await waitForCanvas(() =>
    expect(options.container.textContent).toContain(
      "Saved version 7 · Read-only",
    ),
  );
  const header = options.container.querySelector("header")!;
  const buttons = [...header.querySelectorAll("button")];
  expect(
    buttons.some(
      (button) => button.getAttribute("aria-label") === "Whiteboard",
    ),
  ).toBe(true);
  expect(
    buttons.some((button) => button.getAttribute("aria-label") === "Commits"),
  ).toBe(true);
  expect(
    buttons.some((button) => button.getAttribute("aria-label") === "Diff"),
  ).toBe(true);

  for (const label of [
    "Source tree ↗",
    "Share review",
    "Join our Discord community",
    "Report a bug",
    "Diff settings",
  ]) {
    expect(
      buttons.find((button) => button.getAttribute("aria-label") === label),
    ).toBeUndefined();
  }

  expect(options.container.textContent).not.toContain("Back to latest");
  expect(options.container.textContent).not.toContain("Dismiss");
  expect(options.requests.some((url) => url.pathname.endsWith("/stack"))).toBe(
    false,
  );
  expect(
    options.requests.some((url) => url.pathname.includes("/sharing/")),
  ).toBe(false);
});

it("does not offer a latest-version escape when a saved review cannot load", async () => {
  const options = fixture();
  options.request.mockResolvedValue(
    Response.json({ error: "Saved version is unavailable" }, { status: 404 }),
  );
  await act(async () => disposables.push(mountBrowserReview(options)));
  await waitForCanvas(() =>
    expect(options.container.textContent).toContain(
      "Saved version is unavailable",
    ),
  );
  expect(options.container.querySelector("button")).toBeNull();
  expect(options.request).toHaveBeenCalledTimes(1);
});

it("keeps non-live markdown read-only even when no version was supplied to the canvas", async () => {
  const options = fixture();
  const host = createBrowserReviewBridge(options);
  await act(async () => {
    const canvas = mountReviewCanvas(options.container, {
      kind: "api",
      reviewId: options.reviewId,
      bridge: host.bridge,
      live: false,
    });

    disposables.push(canvas, host);
  });
  await waitForCanvas(() =>
    expect(
      options.container.querySelector('input[type="checkbox"]'),
    ).not.toBeNull(),
  );

  const checkbox = options.container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;

  expect(checkbox.disabled).toBe(true);
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(options.container.textContent).not.toContain("Dismiss");
  expect(
    options.request.mock.calls.some(([, init]) => init?.method === "POST"),
  ).toBe(false);
});

it.each(["browser", "desktop", "without-provider"] as const)(
  "preserves viewed status with %s hosting and only permits supported mutations",
  async (host) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    disposables.push({ dispose: () => root.unmount() });
    const onClick = vi.fn<() => void>();

    const button = (
      <ViewedButton
        label="Source changes"
        progress={{
          state: "partial",
          total: { additions: 3, deletions: 1 },
          remaining: { additions: 2, deletions: 0 },
          folded: { additions: 0, deletions: 0 },
        }}
        onClick={onClick}
      />
    );

    await act(async () =>
      root.render(
        host === "without-provider" ? (
          button
        ) : (
          <ReviewSessionProvider session={testReviewSession({ host })}>
            {button}
          </ReviewSessionProvider>
        ),
      ),
    );

    const rendered = container.querySelector<HTMLButtonElement>(
      'button[role="checkbox"]',
    )!;

    expect(rendered.getAttribute("aria-checked")).toBe("mixed");
    expect(rendered.disabled).toBe(host === "browser");
    await act(async () => rendered.click());
    expect(onClick).toHaveBeenCalledTimes(host === "browser" ? 0 : 1);

    expect(rendered.getAttribute("aria-label")).toBe(
      host === "browser"
        ? "Read-only viewed status: Source changes"
        : "Mark viewed: Source changes",
    );
    expect(rendered.title).toContain(
      host === "browser" ? "read-only" : "Click",
    );
  },
);
