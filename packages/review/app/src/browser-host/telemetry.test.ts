import { testReviewSession } from "@canvas/review-session-test-utils";
import type { ReviewCanvasBridge } from "@dev.fast/review-protocol";
import { expect, it, vi } from "vitest";

it("leaves the desktop app-opened event available after browser telemetry is ignored", async () => {
  vi.resetModules();

  const { captureAppOpened, captureUiEvent } =
    await import("@canvas/ui-telemetry");

  const request = vi.fn<ReviewCanvasBridge["request"]>(async () =>
    Response.json({}),
  );

  const browser = testReviewSession({ host: "browser" }, { request });
  captureAppOpened(browser);
  captureUiEvent(browser, "peek_opened", { via: "diagram" });
  expect(request).not.toHaveBeenCalled();

  const desktop = testReviewSession({ host: "desktop" }, { request });
  captureAppOpened(desktop);
  captureAppOpened(desktop);
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(request.mock.calls[0]![1]?.body)).name).toBe(
    "app_opened",
  );
});
