import type { JsonValue } from "@dev.fast/json";
import { z } from "zod";

import {
  type Connection,
  authorizePath,
  discoverySchema,
  localRequest,
  parseDiscovery,
  probeConnection,
} from "./connection";
import type { routeLayout } from "./layout-worker";
import {
  type Binding,
  ExtensionError,
  type ExtensionMessage,
  bindingSchema,
  canonicalIssue,
  catalogEntrySchema,
  messageSchema,
  reviewIdSchema,
  versionSchema,
} from "./protocol";

export const stateSchema = z.strictObject({
  connection: discoverySchema.nullable(),
  bindings: z.array(bindingSchema).max(1000),
});

export type ExtensionState = z.infer<typeof stateSchema>;

export interface BrokerDependencies {
  extensionId: string;
  load: () => Promise<ExtensionState>;
  save: (state: ExtensionState) => Promise<void>;
  tabUrl: (tabId: number) => Promise<string | undefined>;
  openOptions: () => Promise<void>;
  request: typeof fetch;
  routeLayout: typeof routeLayout;
}

export function isOptionsSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
) {
  return (
    sender.id === extensionId &&
    sender.url === `chrome-extension://${extensionId}/options.html` &&
    (sender.frameId === undefined || sender.frameId === 0)
  );
}

export function senderIssue(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): string | null {
  if (
    sender.id !== extensionId ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.url ||
    !sender.tab.url ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active") ||
    (sender.origin && sender.origin !== "https://linear.app")
  )
    return null;
  const issue = canonicalIssue(sender.tab.url);

  if (!issue) return null;

  if (canonicalIssue(sender.url) === issue) return issue;

  try {
    return sender.documentLifecycle === "active" &&
      new URL(sender.url).origin === "https://linear.app"
      ? issue
      : null;
  } catch {
    return null;
  }
}

const savedSnapshotSchema = z
  .object({
    reviewId: reviewIdSchema,
    version: versionSchema,
    title: z.string().max(1000),
    document: z.json(),
  })
  .catchall(z.json());

const pinSchema = z.object({
  repositoryId: z.string(),
  head: z.string(),
  base: z.string().optional(),
  worktreeRevision: z.string().optional(),
});

const snapshotSourceSchema = z.object({
  target: z.object({ kind: z.string() }).optional(),
  pins: z.object({ worktreeRevision: z.string().optional() }).optional(),
});

const resourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), assetId: z.string() }),
  z.object({ type: z.literal("trace_quote"), traceId: z.string() }),
  z.object({ type: z.literal("software_map"), mapVersionId: z.string() }),
]);

function snapshotScope(snapshot: z.infer<typeof savedSnapshotSchema>) {
  const source = snapshotSourceSchema.parse(snapshot);

  const worktree =
    source.target?.kind === "worktree" || !!source.pins?.worktreeRevision;

  const resources = new Set<string>();
  const maps = new Set<string>();
  const pins = new Set<string>();
  const commits = new Set<string>();
  const pending: JsonValue[] = [snapshot];

  while (pending.length) {
    const value = pending.pop();
    const pin = pinSchema.safeParse(value);

    if (
      pin.success &&
      !pin.data.worktreeRevision &&
      !(worktree && value === snapshot.pins)
    ) {
      pins.add(
        JSON.stringify([
          pin.data.repositoryId,
          pin.data.base ?? "",
          pin.data.head,
        ]),
      );
      commits.add(pin.data.head);

      if (pin.data.base) commits.add(pin.data.base);
    }

    const resource = resourceSchema.safeParse(value);

    if (resource.success) {
      if (resource.data.type === "image") resources.add(resource.data.assetId);

      if (resource.data.type === "trace_quote")
        resources.add(resource.data.traceId);

      if (resource.data.type === "software_map")
        maps.add(resource.data.mapVersionId);
    }

    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    } else if (
      value !== null &&
      value !== undefined &&
      value instanceof Object
    ) {
      for (const child of Object.values(value)) pending.push(child);
    }
  }

  return { resources, maps, pins, commits, worktree };
}

export function createBroker(deps: BrokerDependencies) {
  let mutations = Promise.resolve();

  const snapshots = new Map<
    string,
    Promise<ReturnType<typeof snapshotScope>>
  >();

  async function save(state: ExtensionState) {
    await deps.save(state);
    snapshots.clear();
  }

  async function readSnapshot(
    connection: Connection,
    reviewId: string,
    version: number,
  ) {
    const response = await localRequest(
      connection,
      `/reviews-api/${reviewId}?full=true&version=${version}`,
      deps.request,
    );

    const snapshot = savedSnapshotSchema.parse(JSON.parse(response.body));

    if (snapshot.reviewId !== reviewId || snapshot.version !== version)
      throw new ExtensionError("The saved review version is unavailable.");

    return snapshot;
  }

  function scope(connection: Connection, binding: Binding) {
    const key = `${connection.instanceId}:${binding.reviewId}:${binding.version}`;
    let pending = snapshots.get(key);

    if (!pending) {
      if (snapshots.size >= 16) snapshots.clear();
      pending = readSnapshot(connection, binding.reviewId, binding.version)
        .then(snapshotScope)
        .catch((error) => {
          snapshots.delete(key);
          throw error;
        });
      snapshots.set(key, pending);
    }

    return pending;
  }

  async function run(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) {
    const trusted = isOptionsSender(sender, deps.extensionId);
    const issue = senderIssue(sender, deps.extensionId);

    if (message.type.startsWith("options:") && !trusted) return undefined;

    if (message.type.startsWith("review:") || message.type === "layout:route") {
      if (
        !("issueUrl" in message) ||
        !issue ||
        message.issueUrl !== issue ||
        canonicalIssue((await deps.tabUrl(sender.tab!.id!)) ?? "") !== issue
      )
        return undefined;
    }

    const state = await deps.load();
    const connection = state.connection;

    if (message.type === "options:status")
      return { connected: !!connection, bindings: state.bindings };

    if (message.type === "options:disconnect") {
      await save({ connection: null, bindings: [] });

      return null;
    }

    if (message.type === "options:connect") {
      const next = parseDiscovery(message.source);
      await probeConnection(next, deps.request);
      await save({ connection: next, bindings: [] });

      return null;
    }

    const binding =
      state.bindings.find((entry) => entry.issueUrl === issue) ?? null;

    if (message.type === "review:status")
      return { connected: !!connection, binding };

    if (message.type === "review:options") {
      await deps.openOptions();

      return null;
    }

    if (message.type === "options:unbind") {
      const canonical = canonicalIssue(message.issueUrl);

      if (!canonical)
        throw new ExtensionError("Choose a valid Linear issue URL.");
      await save({
        ...state,
        bindings: state.bindings.filter(
          (entry) => entry.issueUrl !== canonical,
        ),
      });

      return null;
    }

    if (!connection)
      throw new ExtensionError(
        "Connect Whiteboard in extension settings first.",
      );

    if (message.type === "options:catalog") {
      const response = await localRequest(
        connection,
        "/reviews-api",
        deps.request,
      );

      return z
        .array(catalogEntrySchema)
        .max(10000)
        .parse(JSON.parse(response.body));
    }

    if (message.type === "options:bind") {
      const issueUrl = canonicalIssue(message.issueUrl);

      if (!issueUrl)
        throw new ExtensionError("Choose a valid Linear issue URL.");

      const snapshot = await readSnapshot(
        connection,
        message.reviewId,
        message.version,
      );

      const next = {
        issueUrl,
        reviewId: message.reviewId,
        version: message.version,
        title: snapshot.title,
      };

      await save({
        ...state,
        bindings: [
          ...state.bindings.filter((entry) => entry.issueUrl !== issueUrl),
          next,
        ],
      });

      return next;
    }

    if (
      !binding ||
      binding.reviewId !== message.reviewId ||
      binding.version !== message.version
    )
      throw new ExtensionError(
        "This review binding changed. Reopen Whiteboard on this issue.",
      );

    const stillAuthorized = async () => {
      const current = await deps.load();

      const currentBinding = current.bindings.find(
        (entry) => entry.issueUrl === issue,
      );

      if (
        canonicalIssue((await deps.tabUrl(sender.tab!.id!)) ?? "") !== issue ||
        current.connection?.instanceId !== connection.instanceId ||
        current.connection?.token !== connection.token ||
        currentBinding?.reviewId !== binding.reviewId ||
        currentBinding?.version !== binding.version
      ) {
        throw new ExtensionError(
          "This page or review binding changed. Reopen Whiteboard on the current issue.",
        );
      }
    };

    if (message.type === "layout:route") {
      await stillAuthorized();
      const result = await deps.routeLayout(message.graph, message.options);
      await stillAuthorized();

      return result;
    }

    if (message.type === "review:refresh") {
      const response = await localRequest(
        connection,
        `/reviews-api/${binding.reviewId}/history`,
        deps.request,
      );

      const history = z
        .array(z.object({ version: versionSchema }))
        .max(100000)
        .parse(JSON.parse(response.body));

      const latest = history.reduce(
        (version, entry) => Math.max(version, entry.version),
        binding.version,
      );

      const snapshot = await readSnapshot(connection, binding.reviewId, latest);
      await stillAuthorized();

      const next = {
        ...binding,
        version: snapshot.version,
        title: snapshot.title,
      };

      await save({
        ...state,
        bindings: state.bindings.map((entry) =>
          entry.issueUrl === issue ? next : entry,
        ),
      });

      return next;
    }

    const route = authorizePath(message.path, binding);
    const allowed = await scope(connection, binding);

    if (
      (route.endpoint === "resources" &&
        !allowed.resources.has(route.resourceId!)) ||
      (route.endpoint === "maps" && !allowed.maps.has(route.resourceId!))
    )
      throw new ExtensionError(
        "This resource is not part of the bound saved review.",
      );
    const query = new URL(route.path, "http://extension.invalid").searchParams;

    if (
      allowed.worktree &&
      !query.has("repositoryId") &&
      [
        "file",
        "diff",
        "commits",
        "progress",
        "maps",
        "tree",
        "structural-diff",
      ].includes(route.endpoint)
    ) {
      throw new ExtensionError(
        "Immutable source is unavailable for this saved worktree review. Choose a commit-pinned review to inspect source.",
      );
    }

    if (
      ["repositoryId", "base", "head"].some((key) => query.has(key)) &&
      !allowed.pins.has(
        JSON.stringify([
          query.get("repositoryId") ?? "",
          query.get("base") ?? "",
          query.get("head") ?? "",
        ]),
      )
    ) {
      throw new ExtensionError(
        "These source pins are not part of the bound saved review.",
      );
    }

    const commit = query.get("commit");

    if (commit && !allowed.commits.has(commit)) {
      if (!allowed.worktree && /^[a-f0-9]{40}$/i.test(commit)) {
        const range = await localRequest(
          connection,
          `/reviews-api/${binding.reviewId}/commits?version=${binding.version}`,
          deps.request,
        );

        const entries = z
          .array(z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/i) }))
          .parse(JSON.parse(range.body));

        for (const entry of entries) allowed.commits.add(entry.commit);
      }

      if (!allowed.commits.has(commit))
        throw new ExtensionError(
          "This commit is not part of the bound saved review.",
        );
    }

    await stillAuthorized();
    const result = await localRequest(connection, route.path, deps.request);
    await stillAuthorized();

    if (route.endpoint === "history") {
      const history = z
        .array(
          z.object({
            version: versionSchema,
            title: z.string(),
            createdAt: z.string(),
          }),
        )
        .parse(JSON.parse(result.body));

      result.body = JSON.stringify(
        history.filter((entry) => entry.version === binding.version),
      );
    }

    return result;
  }

  return async (raw: JsonValue, sender: chrome.runtime.MessageSender) => {
    if (
      !isOptionsSender(sender, deps.extensionId) &&
      !senderIssue(sender, deps.extensionId)
    )
      return undefined;
    const parsed = messageSchema.safeParse(raw);

    if (!parsed.success)
      return {
        ok: false,
        error: "Unsupported request. The browser canvas is read-only.",
      };
    const message = parsed.data;

    const change = [
      "options:connect",
      "options:disconnect",
      "options:bind",
      "options:unbind",
      "review:refresh",
    ].includes(message.type);

    try {
      const pending = mutations.then(() => run(message, sender));

      if (change)
        mutations = pending.then(
          () => undefined,
          () => undefined,
        );
      const value = await pending;

      return value === undefined ? undefined : { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ExtensionError
            ? error.message
            : "Whiteboard request failed. Check the connection and selected saved review.",
      };
    }
  };
}
