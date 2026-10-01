import { mountBrowserReview } from "../../../packages/review/app/src/browser-host";
import { setLayoutContext } from "./layout-proxy";

export function mountViewer(input: Parameters<typeof mountBrowserReview>[0]) {
  const clearLayout = setLayoutContext(input);
  let viewer;

  try {
    viewer = mountBrowserReview({
      ...input,
      request: (url, init) => {
        const target = new URL(url);

        if (target.origin !== "http://127.0.0.1:1" || target.hash)
          throw new Error(
            "The browser canvas requested an unsupported endpoint.",
          );

        return input.request(`${target.pathname}${target.search}`, init);
      },
    });
  } catch (error) {
    clearLayout();
    throw error;
  }

  return {
    dispose() {
      clearLayout();
      viewer.dispose();
    },
  };
}
