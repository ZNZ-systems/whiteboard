import { testApiDocumentData } from "@canvas/review-session-test-utils";
import type { ReviewInlineEditorSpec } from "@dev.fast/review-protocol";
import { selectSource } from "@review/lens-selection";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { createBrowserReviewBridge } from "./bridge";
import { mountBrowserReview } from "./index";

const disposables: { dispose(): void }[] = [];

const reviewId = "11111111-1111-4111-8111-111111111111";

const file = "src/worker.ts";

const text =
  'export function run() {\n  const literal = "<img src=x onerror=alert(1)>";\n  return "ready";\n}\n';

const patch =
  'diff --git a/src/worker.ts b/src/worker.ts\n@@ -1,2 +1,2 @@\n1 1  export function run() {\n2   -  return "old";\n  2 +  return "ready";\n';

afterEach(async () => {
  await act(async () => {
    for (const disposable of disposables.splice(0)) disposable.dispose();
  });
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

function fixture(
  request: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const container = document.createElement("div");
  const detailContainer = document.createElement("div");
  container.style.height = "600px";
  container.style.width = "900px";
  document.body.append(container, detailContainer);

  return {
    container,
    detailContainer,
    reviewId,
    version: 7,
    wasmUrl: `${location.origin}/unused.wasm`,
    request,
  };
}

const sourceRequest = async (url: string) => {
  const target = new URL(url);

  if (target.pathname.endsWith("/file"))
    return Response.json({
      file: target.searchParams.get("file"),
      side: target.searchParams.get("side"),
      commit: "a".repeat(40),
      text,
    });

  if (target.searchParams.get("file")) return new Response(patch);

  return Response.json([
    { path: file, status: "modified", additions: 1, deletions: 1 },
  ]);
};

function editorSpec(container: HTMLElement): ReviewInlineEditorSpec {
  return {
    container,
    path: file,
    title: file,
    side: "head",
    ranges: [{ startLine: 2, endLine: 3 }],
    heightMode: "capped",
    active: true,
  };
}

it("renders fetched source as text, preserves range and pin coordinates, and supports inline find", async () => {
  const request = vi.fn<typeof sourceRequest>(sourceRequest);
  const options = fixture(request);
  const host = createBrowserReviewBridge(options);
  disposables.push(host);

  const spec = {
    ...editorSpec(options.container),
    pins: { repositoryId: "own-repo", base: "base-pin", head: "head-pin" },
  };

  const editor = host.bridge.inlineEditors.create(spec);
  disposables.push(editor);
  expect(options.container.textContent).toContain("Loading source");
  await vi.waitFor(() =>
    expect(options.container.textContent).toContain('return "ready"'),
  );
  expect(options.container.querySelector("img")).toBeNull();
  expect(options.container.textContent).toContain(
    "<img src=x onerror=alert(1)>",
  );
  expect(
    [
      ...options.container.querySelectorAll<HTMLElement>(
        'tr[data-selected="true"]',
      ),
    ].map((row) => row.dataset.line),
  ).toEqual(["2", "3"]);
  const url = new URL(request.mock.calls[0]![0]);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    version: "7",
    file,
    side: "head",
    repositoryId: "own-repo",
    base: "base-pin",
    head: "head-pin",
  });

  const query = {
    text: "ready",
    matchCase: false,
    wholeWord: true,
    isRegex: false,
  };

  expect(await editor.setFindQuery(query)).toEqual({ matchCount: 1 });
  editor.revealFindMatch(0);
  expect(
    options.container.querySelector('mark[data-active="true"]')?.textContent,
  ).toBe("ready");
  expect(await host.bridge.inlineEditors.find(spec, query)).toEqual({
    matchCount: 1,
  });
  editor.clearFind();
  expect(options.container.querySelector("mark")).toBeNull();
});

it("keeps reveal and diff details alongside the canvas and shows real numbered patch data", async () => {
  const options = fixture(sourceRequest);
  options.container.textContent = "Retained diagram";
  const host = createBrowserReviewBridge(options);
  disposables.push(host);
  const before = location.href;
  expect(
    await host.bridge.post({
      name: "reveal",
      args: { path: file, side: "base", startLine: 3, endLine: 3 },
    }),
  ).toEqual({ ok: true });
  await vi.waitFor(() =>
    expect(options.detailContainer.textContent).toContain('return "ready"'),
  );
  expect(
    options.detailContainer
      .querySelector('tr[data-selected="true"]')
      ?.getAttribute("data-side"),
  ).toBe("base");
  expect(options.detailContainer.classList.contains("review-canvas-root")).toBe(
    true,
  );
  expect(
    await host.bridge.post({ name: "openDiff", args: { path: file } }),
  ).toEqual({ ok: true });
  await vi.waitFor(() =>
    expect(options.detailContainer.textContent).toContain('-  return "old"'),
  );
  expect(
    options.detailContainer
      .querySelector('tr[data-kind="added"]')
      ?.getAttribute("data-head"),
  ).toBe("2");
  expect(options.container.textContent).toBe("Retained diagram");
  expect(location.href).toBe(before);
  options.detailContainer.querySelector<HTMLButtonElement>("button")!.click();
  expect(options.detailContainer.textContent).toBe("");
});

it("shows failed reads and rejects writes, live streams and unsupported host commands", async () => {
  const request = vi.fn<() => Promise<Response>>(async () =>
    Response.json({ error: "Pinned file is unavailable." }, { status: 404 }),
  );

  const options = fixture(request);
  const host = createBrowserReviewBridge(options);
  disposables.push(host);

  const editor = host.bridge.inlineEditors.create(
    editorSpec(options.container),
  );

  disposables.push(editor);
  const error = vi.fn<(message: string) => void>();
  editor.onDidError(error);
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith("Pinned file is unavailable."),
  );
  expect(options.container.querySelector('[role="alert"]')?.textContent).toBe(
    "Pinned file is unavailable.",
  );
  const root = `${host.bridge.config.serverUrl}/reviews-api/${reviewId}`;
  expect(
    (await host.bridge.request(root, { method: "POST", body: "{}" })).status,
  ).toBe(405);
  expect((await host.bridge.request(`${root}/watch`)).status).toBe(405);
  expect(
    (await host.bridge.post({ name: "openReviewRevision", args: {} })).ok,
  ).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(options.detailContainer.textContent).toContain("not supported");
});

it("loads each selected side independently and validates source response identity", async () => {
  const request = vi.fn<typeof sourceRequest>(sourceRequest);
  const options = fixture(request);
  const host = createBrowserReviewBridge(options);
  disposables.push(host);

  const editor = host.bridge.inlineEditors.create({
    ...editorSpec(options.container),
    ranges: [
      { startLine: 2, endLine: 2, side: "base" },
      { startLine: 3, endLine: 3, side: "head" },
    ],
  });

  disposables.push(editor);
  await vi.waitFor(() =>
    expect(
      options.container.querySelectorAll('tr[data-selected="true"]'),
    ).toHaveLength(2),
  );
  expect(
    request.mock.calls.map(([url]) => new URL(url).searchParams.get("side")),
  ).toEqual(["base", "head"]);
  request.mockImplementation(async () =>
    Response.json({ file: "wrong.ts", side: "head", commit: "head", text }),
  );
  await expect(
    host.bridge.inlineEditors.find(editorSpec(options.container), {
      text: "run",
      isRegex: false,
      wholeWord: false,
      matchCase: false,
    }),
  ).rejects.toThrow("does not match");
});

it("pins commit-scoped diffs, reveals selected rows, and reports missing files", async () => {
  const request = vi.fn<typeof sourceRequest>(sourceRequest);
  const options = fixture(request);
  const host = createBrowserReviewBridge(options);
  disposables.push(host);

  const view = host.bridge.diffView.create({
    container: options.container,
    scope: { commit: "b".repeat(40) },
  });

  disposables.push(view);
  view.revealSource?.({ file, side: "head", fromLine: 2, toLine: 2 });
  await vi.waitFor(() =>
    expect(
      options.container
        .querySelector('tr[data-selected="true"]')
        ?.getAttribute("data-head"),
    ).toBe("2"),
  );
  expect(request.mock.calls).toHaveLength(2);

  for (const [url] of request.mock.calls) {
    expect(new URL(url).searchParams.get("version")).toBe("7");
    expect(new URL(url).searchParams.get("commit")).toBe("b".repeat(40));
  }

  expect(new URL(request.mock.calls[0]![0]).searchParams.get("format")).toBe(
    "files",
  );
  expect(new URL(request.mock.calls[1]![0]).searchParams.has("format")).toBe(
    false,
  );
  view.revealFile?.("missing.ts");
  expect(
    options.container.querySelector('[role="alert"]')?.textContent,
  ).toContain("No changes for missing.ts");
});

it("never reads live worktree files as immutable source but allows references with explicit pins", async () => {
  const request = vi.fn<typeof sourceRequest>(async (url: string) =>
    new URL(url).pathname.endsWith("/file")
      ? sourceRequest(url)
      : Response.json({ target: { kind: "worktree" } }),
  );

  const options = fixture(request);
  const host = createBrowserReviewBridge(options);
  disposables.push(host);
  const root = `${host.bridge.config.serverUrl}/reviews-api/${reviewId}`;
  await host.bridge.request(root);

  const response = await host.bridge.request(
    `${root}/file?side=head&file=${file}`,
  );

  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain(
    "Immutable source is unavailable",
  );
  await host.bridge.request(
    `${root}/file?side=head&file=${file}&repositoryId=own&head=pin`,
  );
  expect(request).toHaveBeenCalledTimes(2);
});

it("aborts pending source reads when the mounted host is disposed", async () => {
  let signal: AbortSignal | null | undefined;

  const options = fixture(async (_url, init) => {
    signal = init?.signal;

    return new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      ),
    );
  });

  const host = createBrowserReviewBridge(options);

  const editor = host.bridge.inlineEditors.create(
    editorSpec(options.container),
  );

  disposables.push(editor);
  host.dispose();
  expect(signal?.aborted).toBe(true);
  expect(options.detailContainer.children).toHaveLength(0);
});

it("waits for cold source coverage before resolving saved selections without a live stream", async () => {
  const snapshot = testApiDocumentData([
    {
      id: "peek",
      type: "code_peek",
      source: selectSource({ file, side: "head", fromLine: 2, toLine: 3 }),
    },
  ]).snapshot;

  let finishCoverage!: () => void;

  const coverage = new Promise<void>((resolve) => {
    finishCoverage = resolve;
  });

  const requests: URL[] = [];

  const options = fixture(async (url) => {
    const target = new URL(url);
    requests.push(target);
    const endpoint = target.pathname.split("/").at(-1);

    if (endpoint === reviewId)
      return Response.json({ ...snapshot, version: 7 });

    if (endpoint === "commits") return Response.json([]);

    if (endpoint === "progress") {
      if (target.searchParams.get("wait") !== "true")
        return Response.json(
          { complete: false, files: [], lenses: [], resolvedSelections: {} },
          { status: 202 },
        );

      await coverage;

      return Response.json({
        complete: true,
        files: [],
        lenses: [],
        resolvedSelections: {
          [JSON.stringify([file, "head", 2, "head", 3])]: [
            { file, side: "head", fromLine: 2, toLine: 3 },
          ],
        },
      });
    }

    return sourceRequest(url);
  });

  await act(async () => disposables.push(mountBrowserReview(options)));
  await waitForCanvas(() =>
    expect(requests.some((url) => url.pathname.endsWith("/progress"))).toBe(
      true,
    ),
  );
  expect(
    options.container.querySelector(".browser-review-widget code"),
  ).toBeNull();
  await act(async () => finishCoverage());
  await waitForCanvas(() =>
    expect(
      options.container.querySelector(".browser-review-widget")?.textContent,
    ).toContain('return "ready"'),
  );
  expect(requests.some((url) => url.pathname.endsWith("/watch"))).toBe(false);
  const progress = requests.filter((url) => url.pathname.endsWith("/progress"));
  expect(progress).toHaveLength(1);
  expect(Object.fromEntries(progress[0]!.searchParams)).toMatchObject({
    version: "7",
    mode: "textual",
    wait: "true",
  });
});

it("mounts the existing canvas, opens its real code peek in details, and never watches a saved version", async () => {
  const snapshot = testApiDocumentData([
    {
      id: "intro",
      type: "markdown",
      markdown: "The worker keeps source connected to the diagram.",
    },
    {
      id: "flow",
      type: "sequence",
      title: "Worker flow",
      actors: { app: "Application", worker: "Worker" },
      steps: [
        {
          id: "run-step",
          type: "step",
          from: "app",
          to: "worker",
          label: "Run worker",
          style: "call",
          source: selectSource({ file, side: "head", fromLine: 2, toLine: 3 }),
        },
      ],
    },
    {
      id: "peek",
      type: "code_peek",
      source: selectSource({ file, side: "head", fromLine: 2, toLine: 3 }),
    },
  ]).snapshot;

  const requests: URL[] = [];

  const options = fixture(async (url) => {
    const target = new URL(url);
    requests.push(target);
    const endpoint = target.pathname.split("/").at(-1);

    if (endpoint === reviewId)
      return Response.json({
        ...snapshot,
        version: 7,
        title: "Saved worker review",
      });

    if (endpoint === "commits") return Response.json([]);

    if (endpoint === "progress")
      return Response.json({
        files: [],
        lenses: [],
        resolvedSelections: {
          [JSON.stringify([file, "head", 2, "head", 3])]: [
            { file, side: "head", fromLine: 2, toLine: 3 },
          ],
        },
      });

    if (endpoint === "stack") return Response.json({ layers: [] });

    return sourceRequest(url);
  });

  const onTitle = vi.fn<(title: string) => void>();
  await act(async () =>
    disposables.push(mountBrowserReview({ ...options, onTitle })),
  );
  await waitForCanvas(() =>
    expect(options.container.textContent).toContain('return "ready"'),
  );
  expect(onTitle).toHaveBeenCalledWith("Saved worker review");

  const sequence = options.container.querySelector(
    '[data-review-node-id="flow"]',
  );

  expect(sequence?.textContent).toContain("Worker flow");

  const step = options.container.querySelector<HTMLElement>(
    '[aria-label="Run worker"]',
  );

  expect(step).toBeTruthy();
  await act(async () => step!.click());
  await waitForCanvas(() =>
    expect(
      options.container.querySelector(".browser-review-widget button"),
    ).not.toBeNull(),
  );

  const stage = options.container.querySelector<HTMLElement>(
    ".diagram-tour-overlay > :first-child",
  );

  expect(stage).not.toBeNull();
  expect(getComputedStyle(stage!).display).not.toBe("none");

  const open = [...options.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Open source",
  );

  expect(open).toBeTruthy();
  await act(async () => open!.click());
  await waitForCanvas(() =>
    expect(options.detailContainer.textContent).toContain('return "ready"'),
  );
  expect(options.container.querySelector('[data-review-node-id="flow"]')).toBe(
    sequence,
  );
  expect(requests.some((url) => url.pathname.endsWith("/watch"))).toBe(false);
  expect(requests.every((url) => url.searchParams.get("version") === "7")).toBe(
    true,
  );
  expect(
    options.container.querySelectorAll('[contenteditable="true"]'),
  ).toHaveLength(0);
});
