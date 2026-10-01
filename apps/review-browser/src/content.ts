import { z } from "zod";

import {
  type Binding,
  bindingSchema,
  canonicalIssue,
  responseSchema,
  send,
  statusSchema,
} from "./protocol";
import { mountViewer } from "./viewer";

import shellCss from "./shell.css?inline";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
) {
  const node = document.createElement(tag);
  node.className = className;

  if (text) node.textContent = text;

  return node;
}

let route = "";

let generation = 0;

let host: HTMLElement | undefined;

let disposeViewer: (() => void) | undefined;

let abort: AbortController | undefined;

let frame = 0;

let opened = false;

let suspended = false;

let reload: (() => void) | undefined;

function clearViewer() {
  abort?.abort();
  abort = undefined;
  disposeViewer?.();
  disposeViewer = undefined;
}

function teardown() {
  generation++;
  host?.remove();
  host = undefined;
  clearViewer();
  reload = undefined;
}

function build(issueUrl: string) {
  const current = ++generation;

  const live = () =>
    current === generation && route === location.href && !suspended;

  host = document.createElement("whiteboard-review");
  const shadow = host.attachShadow({ mode: "open" });
  const style = element("style", "");
  style.textContent = shellCss;
  const contentStyle = element("link", "");
  contentStyle.rel = "stylesheet";
  contentStyle.href = chrome.runtime.getURL("assets/content.css");
  const launch = element("button", "wb-launch", "Open Whiteboard");
  launch.type = "button";
  launch.setAttribute("aria-expanded", String(opened));
  const panel = element("section", "wb-panel");
  panel.setAttribute("aria-label", "Whiteboard saved review");
  panel.hidden = !opened;
  const header = element("header", "wb-header");
  const heading = element("div", "wb-heading");
  const title = element("h2", "wb-title", "Whiteboard");

  const label = element(
    "p",
    "wb-version",
    "Saved reviews, alongside your Linear issue",
  );

  heading.append(title, label);
  const controls = element("div", "wb-controls");
  const refresh = element("button", "wb-button", "Refresh saved version");
  const change = element("button", "wb-button", "Change review");
  const close = element("button", "wb-button wb-close", "Close");

  for (const button of [refresh, change, close]) button.type = "button";
  controls.append(refresh, change, close);
  header.append(heading, controls);
  const notice = element("div", "wb-notice");
  notice.setAttribute("role", "status");
  const content = element("div", "wb-content");
  const canvas = element("div", "wb-canvas");
  const details = element("div", "wb-details");
  content.append(canvas, details);
  panel.append(header, notice, content);
  shadow.append(style, contentStyle, launch, panel);
  document.documentElement.append(host);
  let binding: Binding | null = null;
  let loading = 0;

  function reset() {
    clearViewer();
    canvas.replaceChildren();
    details.replaceChildren();
  }

  function message(text: string) {
    notice.replaceChildren(element("p", "", text));
    notice.hidden = false;
  }

  function connectInstructions(connected: boolean) {
    notice.replaceChildren();
    notice.append(
      element(
        "h3",
        "",
        connected
          ? "Choose a saved review for this issue"
          : "Connect your local Whiteboard",
      ),
    );

    if (!connected) {
      notice.append(
        element(
          "p",
          "",
          "Install the Whiteboard CLI, then start its authenticated local server:",
        ),
      );
      notice.append(element("code", "wb-command", "whiteboard server start"));
      notice.append(
        element(
          "p",
          "",
          "In extension settings, import <stateDir>/review-server/server.json. It stays in trusted extension storage and is never shared with Linear.",
        ),
      );
    }

    notice.append(
      element(
        "p",
        "",
        "Select this Linear issue and explicitly bind one local saved review. Only that review’s saved version will appear here.",
      ),
    );

    const setup = element(
      "button",
      "wb-button wb-primary",
      connected ? "Choose saved review" : "Open connection settings",
    );

    setup.type = "button";
    setup.addEventListener("click", openSettings);
    notice.append(setup);
    notice.hidden = false;
  }

  async function openSettings() {
    try {
      await send({ type: "review:options", issueUrl }, z.null());
    } catch (error) {
      if (live())
        message(
          error instanceof Error
            ? error.message
            : "Could not open extension settings.",
        );
    }
  }

  function mount(selected: Binding) {
    reset();
    abort = new AbortController();
    const lifetime = abort.signal;
    const active = () => live() && opened && !lifetime.aborted;
    title.textContent = selected.title;
    label.textContent = `Saved version ${selected.version} · Read-only · ${issueUrl.split("/").at(-1)}`;
    notice.hidden = true;

    const viewer = mountViewer({
      container: canvas,
      detailContainer: details,
      reviewId: selected.reviewId,
      version: selected.version,
      wasmUrl: chrome.runtime.getURL("assets/libavoid.wasm"),
      onTitle: (value) => {
        if (active()) title.textContent = value;
      },
      request: async (path, init = {}) => {
        const signal = init.signal
          ? AbortSignal.any([init.signal, lifetime])
          : lifetime;

        const check = () => {
          signal.throwIfAborted();

          if (!active()) throw new DOMException("Review closed", "AbortError");
        };

        check();

        if ((init.method && init.method !== "GET") || init.body != null)
          throw new Error(
            "The browser canvas is read-only; saving and authoring are unavailable.",
          );

        const pending = send(
          {
            type: "review:request",
            issueUrl,
            reviewId: selected.reviewId,
            version: selected.version,
            path,
            method: "GET",
          },
          responseSchema,
        );

        let onAbort: (() => void) | undefined;

        try {
          const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () =>
              reject(new DOMException("Review closed", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
          });

          const response = await Promise.race([pending, cancelled]);
          check();

          const body =
            response.encoding === "base64"
              ? Uint8Array.from(atob(response.body), (char) =>
                  char.charCodeAt(0),
                )
              : response.body;

          return new Response(
            response.status === 204 || response.status === 205 ? null : body,
            {
              status: response.status,
              headers: { "content-type": response.contentType },
            },
          );
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      },
    });

    disposeViewer = () => viewer.dispose();
  }

  async function load() {
    const revision = ++loading;
    reset();
    refresh.disabled = true;
    message("Checking this issue’s saved review…");

    try {
      const status = await send(
        { type: "review:status", issueUrl },
        statusSchema,
      );

      if (!live() || revision !== loading || !opened) return;
      binding = status.binding;
      refresh.disabled = !binding;

      if (binding) mount(binding);
      else connectInstructions(status.connected);
    } catch (error) {
      if (live() && revision === loading)
        message(
          error instanceof Error
            ? error.message
            : "Could not load this saved review.",
        );
    }
  }

  launch.addEventListener("click", () => {
    opened = true;
    panel.hidden = false;
    launch.hidden = true;
    launch.setAttribute("aria-expanded", "true");
    close.focus();
    void load();
  });

  function closePanel() {
    opened = false;
    loading++;
    panel.hidden = true;
    launch.hidden = false;
    launch.setAttribute("aria-expanded", "false");
    reset();
    launch.focus();
  }

  close.addEventListener("click", closePanel);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePanel();
    }
  });
  change.addEventListener("click", openSettings);
  refresh.addEventListener("click", async () => {
    if (!binding) return;
    const selected = binding;
    const revision = ++loading;
    reset();
    refresh.disabled = true;
    message("Loading the latest saved version of this review…");

    try {
      const next = await send(
        {
          type: "review:refresh",
          issueUrl,
          reviewId: selected.reviewId,
          version: selected.version,
        },
        bindingSchema,
      );

      if (!live() || revision !== loading || !opened) return;
      binding = next;
      refresh.disabled = false;
      mount(next);
    } catch (error) {
      if (live() && revision === loading) {
        refresh.disabled = false;
        message(
          error instanceof Error
            ? error.message
            : "Could not refresh the saved version.",
        );
      }
    }
  });
  reload = () => {
    if (opened) void load();
  };

  launch.hidden = opened;

  if (opened) void load();
}

function reconcile() {
  if (suspended) return;

  if (route !== location.href || (!host && canonicalIssue(location.href))) {
    if (route !== location.href) opened = false;
    teardown();
    route = location.href;
    const issue = canonicalIssue(route);

    if (issue) build(issue);
  }
}

function watchRoute() {
  reconcile();
  frame = requestAnimationFrame(watchRoute);
}

window.navigation?.addEventListener("navigate", () => {
  teardown();
  opened = false;
  setTimeout(reconcile, 0);
});

window.addEventListener("popstate", reconcile);

window.addEventListener("hashchange", reconcile);

window.addEventListener("pagehide", () => {
  suspended = true;
  cancelAnimationFrame(frame);
  teardown();
});

window.addEventListener("pageshow", () => {
  if (!suspended) return;
  suspended = false;
  watchRoute();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;

  const parsed = z
    .object({
      type: z.enum(["review:route-changed", "review:binding-changed"]),
    })
    .safeParse(message);

  if (!parsed.success) return;

  if (parsed.data.type === "review:route-changed") reconcile();
  else reload?.();
});

watchRoute();
