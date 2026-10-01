import {
  type ReviewCanvasBridge,
  type ReviewDisposable,
  type ReviewInlineEditorSpec,
  ReviewRuntimeConfigSchema,
  type ReviewSurfaceEvent,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { createDiffViews } from "./diff-view";
import { element } from "./dom";
import { createInlineEditors } from "./inline-editor";
import { createSourceClient } from "./source";

export interface BrowserReviewOptions {
  container: HTMLElement;
  detailContainer: HTMLElement;
  reviewId: string;
  version: number;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  wasmUrl: string;
  onTitle?: (title: string) => void;
}

const snapshotSource = z.object({
  target: z.object({ kind: z.string() }).optional(),
  pins: z.object({ worktreeRevision: z.string().optional() }).optional(),
});

export function createBrowserReviewBridge(options: BrowserReviewOptions) {
  if (!Number.isSafeInteger(options.version) || options.version < 0)
    throw new Error("A non-negative saved review version is required.");

  const config = ReviewRuntimeConfigSchema.parse({
    serverUrl: "http://127.0.0.1:1",
    token: "",
    reviewId: options.reviewId,
    wasmUrl: options.wasmUrl,
    appVersion: "browser",
    theme: "light",
    host: "browser",
  });

  const abort = new AbortController();
  const prefix = `/reviews-api/${encodeURIComponent(options.reviewId)}`;
  let worktree = false;

  const failure = (error: string, status = 405) =>
    Response.json({ error }, { status });

  const request = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const target = new URL(url);

    if (
      target.origin !== config.serverUrl ||
      (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))
    )
      return failure("This browser host only reads the selected saved review.");

    if ((init?.method ?? "GET").toUpperCase() !== "GET")
      return failure(
        "This saved review is read-only. Changes are not supported in the browser.",
      );
    const endpoint = target.pathname.slice(prefix.length);

    if (endpoint === "/watch")
      return failure(
        "Live updates are not supported for saved browser reviews.",
      );

    if (
      worktree &&
      /^\/(file|diff|commits|progress|maps|tree|structural-diff)(\/|$)/.test(
        endpoint,
      ) &&
      !target.searchParams.has("repositoryId")
    )
      return failure(
        "Immutable source is unavailable for this worktree review. Open a commit-pinned review to inspect saved source.",
        409,
      );
    target.searchParams.set("version", String(options.version));

    if (endpoint === "/progress") target.searchParams.set("wait", "true");
    target.searchParams.delete("token");
    const headers = new Headers(init?.headers);
    headers.delete("x-review-token");
    headers.delete("authorization");

    const response = await options.request(target.href, {
      ...init,
      headers,
      credentials: "omit",
      signal: init?.signal
        ? AbortSignal.any([abort.signal, init.signal])
        : abort.signal,
    });

    if (response.ok && endpoint === "") {
      const snapshot = snapshotSource.parse(await response.clone().json());
      worktree =
        snapshot.target?.kind === "worktree" ||
        Boolean(snapshot.pins?.worktreeRevision);
    }

    return response;
  };

  const source = createSourceClient(config, options.version, request);
  const document = options.detailContainer.ownerDocument;

  const detailWasScoped =
    options.detailContainer.classList.contains("review-canvas-root");

  const detailBackground = options.detailContainer.style.backgroundColor;
  options.detailContainer.style.backgroundColor = "#fff";

  options.detailContainer.classList.add("review-canvas-root");

  const detail = element(
    document,
    "section",
    undefined,
    "browser-review-detail",
  );

  detail.setAttribute("aria-label", "Saved review details");
  detail.hidden = true;
  options.detailContainer.append(detail);
  let active: ReviewDisposable | undefined;
  let disposed = false;
  const listeners = new Set<(event: ReviewSurfaceEvent) => void>();
  const emptySubscription = () => ({ dispose() {} });

  const close = () => {
    active?.dispose();
    active = undefined;
    detail.replaceChildren();
    detail.hidden = true;
  };

  const prepare = () => {
    close();
    detail.hidden = false;

    const button = element(
      document,
      "button",
      "Close details",
      "browser-review-detail-close",
    );

    button.type = "button";
    button.addEventListener("click", () => {
      close();
      options.container.focus();
    });
    const host = element(document, "div");
    detail.append(button, host);

    return host;
  };

  const notify = (text: string) => {
    detail.hidden = false;
    let notice = detail.querySelector<HTMLElement>("[role=alert]");

    if (!notice) {
      notice = element(document, "p", undefined, "browser-review-status");
      notice.setAttribute("role", "alert");
      detail.append(notice);
    }

    notice.textContent = text;
  };

  const open = (spec: ReviewInlineEditorSpec) => {
    if (disposed) return;
    const container = prepare();
    active = inlineEditors.create({
      ...spec,
      container,
      heightMode: "capped",
      active: true,
    });
    container.querySelector<HTMLElement>("section")?.focus();
  };

  const inlineEditors = createInlineEditors(source, open);
  const diffView = createDiffViews(source);

  const openDiff = (path?: string) => {
    const container = prepare();
    const view = diffView.create({ container });
    active = view;

    if (path) view.revealFile?.(path);
    view.focus();
  };

  const bridge: ReviewCanvasBridge = {
    config,
    request,
    inlineEditors,
    diffView,
    async post(command) {
      if (disposed)
        return { ok: false, error: "This browser review has been closed." };

      if (command.name === "reveal") {
        open({
          container: options.detailContainer,
          path: command.args.path,
          title: `${command.args.path} · ${command.args.side ?? "head"} · version ${options.version}`,
          side: command.args.side ?? "head",
          pins: command.args.pins,
          ranges: [
            {
              startLine: command.args.startLine,
              endLine: command.args.endLine,
            },
          ],
          heightMode: "capped",
          active: true,
        });

        return { ok: true };
      }

      if (command.name === "openDiff") {
        openDiff(command.args.path);

        return { ok: true };
      }

      if (command.name === "showReviewView") {
        if (command.args.view === "diff") openDiff();
        else
          for (const listener of listeners)
            listener({ event: "showReviewView", view: command.args.view });

        return { ok: true };
      }

      if (command.name === "focusWindow") {
        options.container.focus();

        return { ok: true };
      }

      const error = `“${command.name}” is not supported in this read-only saved review.`;
      notify(error);

      return { ok: false, error };
    },
    subscribe(listener) {
      listeners.add(listener);

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    currentTheme: () => "light",
    onDidChangeTheme: emptySubscription,
    currentDiffLayout: () => "unified",
    async setDiffLayout(layout) {
      if (layout === "unified") return;

      const error =
        "Split diff layout is not supported in the browser source viewer.";

      notify(error);
      throw new Error(error);
    },
    onDidChangeDiffLayout: emptySubscription,
    ready() {},
    notify: ({ text }) => notify(text),
    setupTooltip(target, text) {
      const previous = target.getAttribute("title");
      target.title = text;

      return {
        dispose() {
          if (previous === null) target.removeAttribute("title");
          else target.title = previous;
        },
      };
    },
  };

  return {
    bridge,
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      close();
      listeners.clear();
      detail.remove();

      if (!detailWasScoped)
        options.detailContainer.classList.remove("review-canvas-root");
      options.detailContainer.style.backgroundColor = detailBackground;
    },
  };
}
