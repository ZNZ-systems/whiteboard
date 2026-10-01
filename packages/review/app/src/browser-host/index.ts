import { mountReviewCanvas } from "@canvas/desktop-entry";

import { type BrowserReviewOptions, createBrowserReviewBridge } from "./bridge";

import "./style.css";

export type { BrowserReviewOptions } from "./bridge";

export function mountBrowserReview(options: BrowserReviewOptions) {
  const host = createBrowserReviewBridge(options);
  const containment = options.container.style.contain;
  options.container.style.contain = "layout paint";

  const canvas = mountReviewCanvas(options.container, {
    kind: "api",
    reviewId: options.reviewId,
    version: options.version,
    live: false,
    structuralDiffEnabled: false,
    softwareMapEnabled: true,
    bridge: host.bridge,
    setTitle: options.onTitle,
  });

  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.dispose();
      host.dispose();
      options.container.style.contain = containment;
    },
  };
}
