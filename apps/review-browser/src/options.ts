import { z } from "zod";

import {
  type CatalogEntry,
  bindingSchema,
  canonicalIssue,
  catalogEntrySchema,
  optionsStatusSchema,
  send,
} from "./protocol";

const discovery = document.querySelector<HTMLInputElement>("#discovery")!;

const issueTabs = document.querySelector<HTMLSelectElement>("#issue-tab")!;

const issueUrl = document.querySelector<HTMLInputElement>("#issue-url")!;

const review = document.querySelector<HTMLSelectElement>("#review")!;

const bind = document.querySelector<HTMLButtonElement>("#bind")!;

const reloadReviews =
  document.querySelector<HTMLButtonElement>("#reload-reviews")!;

const disconnect = document.querySelector<HTMLButtonElement>("#disconnect")!;

const status = document.querySelector<HTMLDivElement>("#status")!;

const selection = document.querySelector<HTMLParagraphElement>("#selection")!;

const connectionState =
  document.querySelector<HTMLParagraphElement>("#connection-state")!;

const bindings = document.querySelector<HTMLUListElement>("#bindings")!;

let catalog: CatalogEntry[] = [];

let connected = false;

let busy = false;

function report(error: Error | string) {
  status.textContent = error instanceof Error ? error.message : error;
}

function updateSelection() {
  const selected = catalog.find((entry) => entry.reviewId === review.value);
  const issue = canonicalIssue(issueUrl.value.trim());
  bind.disabled = busy || !connected || !selected || !issue;
  selection.textContent = selected
    ? `${selected.title} · Saved version ${selected.version}${issue ? ` → ${issue}` : " · Choose a valid Linear issue URL"}`
    : "Select one review to explicitly allow it on this issue.";
}

async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  discovery.disabled = true;
  disconnect.disabled = true;
  reloadReviews.disabled = true;
  updateSelection();

  try {
    await action();
  } catch (error) {
    report(
      error instanceof Error
        ? error
        : "Whiteboard settings could not be updated.",
    );
  } finally {
    busy = false;
    discovery.disabled = false;
    disconnect.disabled = !connected;
    reloadReviews.disabled = !connected;
    updateSelection();
  }
}

async function loadStatus() {
  const state = await send({ type: "options:status" }, optionsStatusSchema);
  connected = state.connected;
  connectionState.textContent = connected
    ? "Local connection configured"
    : "Not connected";
  disconnect.disabled = !connected || busy;
  reloadReviews.disabled = !connected || busy;
  bindings.replaceChildren();

  for (const entry of state.bindings) {
    const item = document.createElement("li");
    item.textContent = `${entry.issueUrl} — ${entry.title} · Saved version ${entry.version}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Unbind";
    remove.addEventListener(
      "click",
      () =>
        void run(async () => {
          await send(
            { type: "options:unbind", issueUrl: entry.issueUrl },
            z.null(),
          );
          await loadStatus();
          report("Review unbound. It is no longer available on that issue.");
        }),
    );
    item.append(remove);
    bindings.append(item);
  }

  if (!state.bindings.length) {
    const empty = document.createElement("li");
    empty.textContent = "No issue has access to a local review yet.";
    bindings.append(empty);
  }

  updateSelection();
}

async function loadCatalog() {
  catalog = [];
  review.replaceChildren(
    new Option(
      connected ? "Loading saved reviews…" : "Connect Whiteboard first",
      "",
    ),
  );
  review.disabled = true;

  if (!connected) return;
  catalog = await send(
    { type: "options:catalog" },
    z.array(catalogEntrySchema),
  );
  review.replaceChildren(
    new Option(
      catalog.length ? "Choose a saved review…" : "No saved reviews found",
      "",
    ),
  );

  for (const entry of catalog)
    review.append(
      new Option(
        `${entry.title} · v${entry.version}${entry.repositoryName ? ` · ${entry.repositoryName}` : ""}`,
        entry.reviewId,
      ),
    );
  review.disabled = !catalog.length;
  updateSelection();
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({ url: "https://linear.app/*" });
  tabs.sort(
    (left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0),
  );
  issueTabs.replaceChildren(new Option("Choose an open Linear issue…", ""));
  const seen = new Set<string>();

  for (const tab of tabs) {
    const issue = canonicalIssue(tab.url ?? "");

    if (!issue || seen.has(issue)) continue;
    seen.add(issue);
    issueTabs.append(new Option(`${tab.title ?? issue} — ${issue}`, issue));

    if (!issueUrl.value) {
      issueUrl.value = issue;
      issueTabs.value = issue;
    }
  }

  updateSelection();
}

discovery.addEventListener(
  "change",
  () =>
    void run(async () => {
      const file = discovery.files?.[0];
      discovery.value = "";

      if (!file) return;

      if (file.size > 16384)
        throw new Error("This file is too large for a Whiteboard server.json.");
      report("Verifying the local server identity…");
      await send(
        { type: "options:connect", source: await file.text() },
        z.null(),
      );
      await loadStatus();
      await loadCatalog();
      report(
        "Connected. Choose a saved review and explicitly bind it to a Linear issue.",
      );
    }),
);

disconnect.addEventListener(
  "click",
  () =>
    void run(async () => {
      await send({ type: "options:disconnect" }, z.null());
      await loadStatus();
      await loadCatalog();
      report(
        "Disconnected. The local credential and all issue bindings were removed.",
      );
    }),
);

bind.addEventListener(
  "click",
  () =>
    void run(async () => {
      const selected = catalog.find((entry) => entry.reviewId === review.value);
      const issue = canonicalIssue(issueUrl.value.trim());

      if (!selected || !issue)
        throw new Error(
          "Choose a saved review and a valid Linear issue URL first.",
        );

      const bound = await send(
        {
          type: "options:bind",
          issueUrl: issue,
          reviewId: selected.reviewId,
          version: selected.version,
        },
        bindingSchema,
      );

      await loadStatus();
      report(
        `Bound ${bound.title}, saved version ${bound.version}. Return to the Linear issue and open Whiteboard.`,
      );
    }),
);

reloadReviews.addEventListener(
  "click",
  () =>
    void run(async () => {
      await loadCatalog();
      report("Saved review catalog reloaded.");
    }),
);

document
  .querySelector("#reload-tabs")!
  .addEventListener("click", () => void run(loadTabs));

issueTabs.addEventListener("change", () => {
  issueUrl.value = issueTabs.value;
  updateSelection();
});

issueUrl.addEventListener("input", updateSelection);

review.addEventListener("change", updateSelection);

void run(async () => {
  await Promise.all([loadStatus(), loadTabs()]);
  await loadCatalog();
});
