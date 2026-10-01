import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "@dev.fast/json";
import { type Video, chromium } from "playwright";
import { z } from "zod";

import type { ReviewServerDiscovery } from "../../../packages/review/src/server-discovery";
import { runHeadlessServer } from "../../../packages/review/src/server/headless-host";

const root = await mkdtemp(
  path.join(
    process.env.WHITEBOARD_E2E_STATE_ROOT ?? os.tmpdir(),
    "whiteboard-extension-",
  ),
);

const stateDir = path.join(root, "state");

const repository = path.join(root, "repository");

const artifacts = process.env.WHITEBOARD_E2E_ARTIFACTS;

await mkdir(repository);

if (artifacts) await mkdir(artifacts, { recursive: true });

process.env.DEV_FAST_REVIEW_TELEMETRY_DISABLED = "1";

process.env.DEV_REVIEW_HOME = stateDir;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

git("init", "-q");

await writeFile(
  path.join(repository, "retry.ts"),
  "export const retryDelay = 100;\n",
);

await writeFile(
  path.join(repository, "worker.ts"),
  "export const deliver = () => false;\n",
);

git("add", ".");

git("commit", "-qm", "Initial delivery fixture");

const base = git("rev-parse", "HEAD");

await writeFile(
  path.join(repository, "retry.ts"),
  [
    "export function scheduleRetry(attempt: number) {",
    "  const delay = Math.min(30_000, 100 * 2 ** attempt);",
    "  return { delay, retryable: attempt < 5 };",
    "}",
    "",
  ].join("\n"),
);

await writeFile(
  path.join(repository, "worker.ts"),
  [
    "export function deliverJob(id: string) {",
    "  const receipt = `delivered:${id}`;",
    "  return { receipt, acknowledged: true };",
    "}",
    "",
  ].join("\n"),
);

git("commit", "-qam", "Bound retries and acknowledge delivered jobs");

const head = git("rev-parse", "HEAD");

const stop = new AbortController();

const ready = Promise.withResolvers<ReviewServerDiscovery>();

const running = runHeadlessServer({
  stateDir,
  signal: stop.signal,
  onReady: ready.resolve,
});

const connection = await Promise.race([
  ready.promise,
  running.then(() => {
    throw new Error("Server exited before readiness");
  }),
]);

async function api(route: string, body?: JsonObject) {
  const response = await fetch(`${connection.url}/reviews-api${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      "x-review-token": connection.token,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const result = await response.json();
  assert.equal(
    response.ok,
    true,
    `Fixture API ${route} returned ${response.status}: ${JSON.stringify(result)}`,
  );

  return result;
}

const registered = z
  .object({ id: z.string() })
  .parse(await api("/repositories", { path: repository }));

const created = z.object({ reviewId: z.string() }).parse(
  await api("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Retry delivery — interactive review",
      target: { kind: "commits", repositoryId: registered.id, base, head },
    },
  }),
);

await api("/commands", {
  commandId: randomUUID(),
  operation: {
    type: "edit",
    reviewId: created.reviewId,
    edit: {
      type: "insert",
      content: {
        type: "sequence",
        title: "Bounded retry delivery",
        actors: {
          client: "Caller",
          scheduler: "Retry scheduler",
          worker: "Delivery worker",
        },
        steps: [
          {
            from: "client",
            to: "scheduler",
            label: "Schedule retry",
            source: {
              file: "retry.ts",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 4 },
            },
          },
          {
            from: "scheduler",
            to: "worker",
            label: "Deliver job",
            source: {
              file: "worker.ts",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 4 },
            },
          },
        ],
      },
    },
  },
});

const saved = z.object({ version: z.number() }).parse(
  await api("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId: created.reviewId,
      edit: {
        type: "insert",
        content: {
          type: "database_lens",
          title: "Receipt model",
          actors: { worker: { label: "Delivery worker" } },
          stores: {
            receipts: {
              label: "Receipt store",
              storage: "relational",
              collections: {
                delivery: {
                  label: "Delivery receipts",
                  fields: {
                    status: {
                      label: "status",
                      dataType: "text",
                      example: "acknowledged",
                    },
                  },
                },
              },
            },
          },
          useCases: [
            {
              label: "Acknowledge delivery",
              operations: [
                {
                  kind: "write",
                  store: "receipts",
                  collection: "delivery",
                  field: "status",
                  actor: "worker",
                  label: "Write receipt",
                  source: {
                    file: "worker.ts",
                    start: { side: "head", line: 1 },
                    end: { side: "head", line: 4 },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  }),
);

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const extensionPath = path.join(appRoot, "dist");

const context = await chromium.launchPersistentContext(
  path.join(root, "browser"),
  {
    channel: "chromium",
    headless: !process.env.WHITEBOARD_E2E_HEADED,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1600, height: 1050 },
    args: ["--enable-unsafe-extension-debugging", "--no-sandbox"],
    recordVideo: artifacts
      ? { dir: artifacts, size: { width: 1600, height: 1050 } }
      : undefined,
  },
);

const errors: string[] = [];

const directRequests: string[] = [];

let video: Video | null = null;

async function capturePause() {
  if (artifacts) await new Promise((resolve) => setTimeout(resolve, 900));
}

try {
  const browser = context.browser();
  assert.ok(browser);
  const session = await browser.newBrowserCDPSession();

  const { id: extensionId } = await session.send("Extensions.loadUnpacked", {
    path: extensionPath,
  });

  await context.route("https://linear.app/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'",
      },
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Linear host fixture — not a live workspace</title><style>body{background:#18191d;color:#e8e9ee;font:16px system-ui;margin:0}aside{width:210px;position:fixed;inset:0 auto 0 0;background:#111216;padding:30px}main{margin-left:280px;padding:48px}small{color:#aab0bc}h1{font-size:30px}p{max-width:600px;line-height:1.6}</style></head><body><aside>HOST FIXTURE<br><small>Automated integration test</small></aside><main><small>ENG-42 · In review</small><h1>Bound retries and acknowledge deliveries</h1><p>This is a synthetic host page. The extension, saved review, diagram renderer, pinned Git source and authenticated local API are real.</p></main></body></html>`,
    }),
  );
  const issue = await context.newPage();
  video = issue.video();
  issue.on("request", (request) => {
    if (request.url().startsWith("http://127.0.0.1"))
      directRequests.push(request.url());
  });
  issue.on("pageerror", (error) => errors.push(error.message));
  issue.on("console", (message) => {
    if (
      message.type() === "error" &&
      /libavoid|wasm|unsafe-eval/i.test(message.text())
    )
      errors.push(message.text());
  });
  await issue.goto(
    "https://linear.app/whiteboard-test/issue/ENG-42/bounded-retries",
  );
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options
    .getByLabel("Server discovery file")
    .setInputFiles(path.join(stateDir, "review-server/server.json"));
  await options.getByLabel("Linear issue URL").fill(issue.url());
  await options.getByLabel("Local saved review").selectOption(created.reviewId);
  await options
    .getByRole("button", { name: "Bind saved review to issue", exact: true })
    .click();
  await options
    .getByRole("status")
    .filter({ hasText: "Return to the Linear issue and open Whiteboard." })
    .waitFor();
  await issue.bringToFront();
  await issue
    .getByRole("button", { name: "Open Whiteboard", exact: true })
    .click();
  await issue
    .getByText("Bounded retry delivery", { exact: true })
    .first()
    .waitFor();
  await issue
    .getByText("Receipt model", { exact: true })
    .first()
    .scrollIntoViewIfNeeded();
  await issue
    .getByText("Receipt store", { exact: true })
    .filter({ visible: true })
    .first()
    .waitFor();
  await issue
    .getByText("Bounded retry delivery", { exact: true })
    .first()
    .scrollIntoViewIfNeeded();
  await capturePause();
  const initialUrl = issue.url();
  const tabs = context.pages().length;
  await issue.getByText("Schedule retry", { exact: true }).first().click();
  await issue
    .getByText("export function scheduleRetry(attempt: number) {", {
      exact: true,
    })
    .first()
    .waitFor();
  await capturePause();

  if (artifacts)
    await issue.screenshot({
      path: path.join(artifacts, "schedule-retry.png"),
    });

  const tour = issue.getByRole("dialog", {
    name: "Bounded retry delivery tour",
  });

  await tour.getByText("Deliver job", { exact: true }).first().click();
  await issue
    .getByText("export function deliverJob(id: string) {", { exact: true })
    .first()
    .waitFor();
  await tour
    .locator(".browser-review-widget")
    .filter({ hasText: "worker.ts:1-4" })
    .getByRole("button", { name: "Open source", exact: true })
    .click();
  await issue
    .getByRole("region", { name: "Saved review details" })
    .getByText("export function deliverJob(id: string) {", { exact: true })
    .waitFor();

  const detailBox = await issue
    .getByRole("region", { name: "Saved review details" })
    .boundingBox();

  const diagramBox = await tour.boundingBox();
  assert.ok(detailBox && diagramBox);
  assert.ok(
    detailBox.x >= diagramBox.x + diagramBox.width - 1,
    `Source details must not be hidden under the diagram: ${JSON.stringify({ detailBox, diagramBox })}`,
  );
  await capturePause();
  assert.equal(
    issue.url(),
    initialUrl,
    "Node selection must stay inside the issue",
  );
  assert.equal(
    context.pages().length,
    tabs,
    "Node selection must not open a new tab",
  );

  const pageMarkup = await issue.evaluate(
    () =>
      document.documentElement.innerHTML +
      document.querySelector("whiteboard-review")?.shadowRoot?.innerHTML,
  );

  assert.equal(pageMarkup.includes(connection.token), false);

  if (artifacts)
    await issue.screenshot({ path: path.join(artifacts, "deliver-job.png") });

  await api("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId: created.reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Updated review evidence." },
      },
    },
  });
  await issue
    .getByRole("button", { name: "Refresh saved version", exact: true })
    .click();
  await issue.getByText("Updated review evidence.", { exact: true }).waitFor();
  await issue
    .getByText(`Saved version ${saved.version + 1}`, { exact: false })
    .first()
    .waitFor();
  await issue.evaluate(() =>
    history.pushState({}, "", "/whiteboard-test/issue/ENG-43/unrelated"),
  );
  await issue
    .getByText("Bounded retry delivery", { exact: true })
    .first()
    .waitFor({ state: "hidden" });
  await capturePause();
  assert.deepEqual(
    directRequests,
    [],
    "The host page must never contact the local server directly",
  );
  assert.deepEqual(
    errors,
    [],
    "The packaged extension must not produce uncaught browser errors",
  );
  console.log(
    "PASS: packaged MV3 extension, authenticated pairing, issue binding, real canvas, two pinned source selections, in-page refresh, and SPA teardown.",
  );

  if (process.env.WHITEBOARD_E2E_KEEP_STATE)
    console.log(`Retained fixture state: ${stateDir}`);
} catch (error) {
  if (errors.length) console.error(errors.join("\n"));

  if (artifacts) {
    for (const [index, page] of context.pages().entries())
      await page
        .screenshot({ path: path.join(artifacts, `failure-${index}.png`) })
        .catch(() => {});
  }

  throw error;
} finally {
  if (video && artifacts) {
    for (const page of context.pages())
      if (page.video() === video) await page.close();

    await video.saveAs(path.join(artifacts, "linear-fixture-interaction.webm"));
  }

  await context.close();
  stop.abort();
  await running;

  if (!process.env.WHITEBOARD_E2E_KEEP_STATE)
    await rm(root, { recursive: true, force: true });
}
