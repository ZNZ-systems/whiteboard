import { isStringValue } from "@dev.fast/review-protocol";
import { type LensSource, sourceAnchors } from "@review/lens-selection.js";
import { type MarkdownNode, parseMarkdown } from "@review/markdown.js";
import type { Block, DatabaseField } from "@review/review-api/document.js";
import { pullRequestUrl } from "@review/review-api/origin.js";
import type { Snapshot } from "@review/review-api/store.js";
import {
  type FileLineRange,
  type SourcePins,
  checkSourcePath,
  fileLineRangeSchema,
} from "@review/source.js";

export type LinearAttachmentSnapshot = Pick<
  Snapshot,
  "reviewId" | "version" | "title" | "document" | "pins" | "origin"
>;

interface AttachmentMessage {
  subject?: string;
  body?: string;
  timestamp?: string;
}

export interface LinearAttachment {
  title: string;
  subtitle: string;
  url: string;
  metadata: {
    title: string;
    messages: AttachmentMessage[];
    attributes: { name: string; value: string }[];
  };
}

const traceOmitted = "[Trace quote omitted for privacy.]";

const messageLimit = 9_999;

function plainText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/!\[/g, "!［")
    .replace(/\b[a-z][a-z\d+.-]*:(?=\/\/)/gi, (scheme) =>
      /^https?:$/i.test(scheme) ? scheme : scheme.replace(":", "∶"),
    )
    .replace(
      /\b(?:javascript|vbscript|data|file|review-source|review-trace|vscode|command):/gi,
      (scheme) => scheme.replace(":", "∶"),
    );
}

function safeUrl(href: string): string | undefined {
  if (/[\s<>\u0000-\u001f\u007f]/.test(href)) return undefined;

  try {
    const url = new URL(href);

    if (url.username || url.password) return undefined;

    if (
      ((url.protocol === "https:" || url.protocol === "http:") &&
        /^https?:\/\//i.test(href)) ||
      (url.protocol === "mailto:" && url.pathname.includes("@"))
    )
      return url.href;
  } catch {
    return undefined;
  }

  return undefined;
}

function messageLength(message: AttachmentMessage): number {
  return (
    (message.subject?.length ?? 0) +
    (message.body?.length ?? 0) +
    (message.timestamp?.length ?? 0)
  );
}

function limitMessages(messages: AttachmentMessage[]): AttachmentMessage[] {
  if (
    messages.reduce((sum, message) => sum + messageLength(message), 0) <=
    messageLimit
  )
    return messages;

  const notice = {
    subject: "Preview truncated",
    body: "Preview truncated to fit Linear's limit. Open the attached review for the full authored content.",
  };

  let remaining = messageLimit - messageLength(notice);
  const preview: AttachmentMessage[] = [];

  for (const message of messages) {
    if (remaining <= 0) break;
    const subject = (message.subject ?? "").slice(0, remaining);
    remaining -= subject.length;
    const body = (message.body ?? "").slice(0, remaining);
    remaining -= body.length;
    preview.push({ subject, body });
  }

  return [...preview, notice];
}

export function buildLinearAttachment(
  snapshot: LinearAttachmentSnapshot,
  url: string,
): LinearAttachment {
  const origin = pullRequestUrl.safeParse(snapshot.origin?.pullRequestUrl);

  const repositoryUrl = origin.success
    ? origin.data.replace(/\/pull\/\d+$/, "")
    : undefined;

  const sourceText = (source: FileLineRange): string => {
    const pins = source.pins ?? snapshot.pins;

    const commit =
      source.side === "base" ? (pins?.base ?? pins?.head) : pins?.head;

    const foreign =
      source.pins !== undefined &&
      source.pins.repositoryId !== snapshot.pins?.repositoryId;

    const location = plainText(
      `${source.file}:${source.fromLine}${source.toLine === source.fromLine ? "" : `-${source.toLine}`} (${source.side}${commit ? ` at ${commit}` : ""}${foreign ? (snapshot.pins ? "; different repository" : "; repository identity unavailable") : ""})`,
    );

    if (
      !repositoryUrl ||
      foreign ||
      !commit ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)
    )
      return location;

    try {
      checkSourcePath(source.file);
    } catch {
      return location;
    }

    const file = source.file.split("/").map(encodeURIComponent).join("/");
    const lines = `#L${source.fromLine}${source.toLine === source.fromLine ? "" : `-L${source.toLine}`}`;

    return `${location}: ${repositoryUrl}/blob/${commit}/${file}${lines}`;
  };

  const selectionText = (source: LensSource): string =>
    sourceAnchors(source).map(sourceText).join("; ");

  const prose = (markdown: string, pins?: SourcePins): string => {
    const render = (node: MarkdownNode): string => {
      if (node.type === "html" || node.type === "definition") return "";

      if (node.type === "image" || node.type === "imageReference")
        return `Image: ${plainText(node.alt ?? "image")} (not embedded)`;

      if (node.type === "link" && /^review-trace:/i.test(node.url ?? ""))
        return traceOmitted;

      const children = (node.children ?? []).map(render);
      const text = children.join("");

      if (node.type === "link") {
        const href = node.url ?? "";

        if (/^review-source:/i.test(href)) {
          const match =
            /^review-source:(base|head)\/(.+)#L(\d+)(?:-L(\d+))?$/i.exec(href);

          if (match) {
            try {
              const source = fileLineRangeSchema.safeParse({
                side: match[1]!.toLowerCase(),
                file: decodeURIComponent(match[2]!),
                fromLine: Number(match[3]),
                toLine: Number(match[4] ?? match[3]),
                pins: pins
                  ? { ...pins, base: pins.base ?? pins.head }
                  : undefined,
              });

              if (source.success) return `${text} — ${sourceText(source.data)}`;
            } catch {
              return `${text} (source location unavailable)`;
            }
          }

          return `${text} (source location unavailable)`;
        }

        const destination = safeUrl(href);

        return destination
          ? text === destination
            ? destination
            : `${text} (${destination})`
          : text.replace(/:/g, "∶");
      }

      switch (node.type) {
        case "root":
        case "blockquote":
        case "listItem":
        case "table":
          return children.filter(Boolean).join("\n\n");
        case "list":
          return children
            .map(
              (child, index) =>
                `${node.ordered ? `${(node.start ?? 1) + index}.` : "•"} ${child}`,
            )
            .join("\n");
        case "tableRow":
          return children.join(" | ");
        case "break":
          return "\n";
        case "thematicBreak":
          return "—";
        default:
          return node.value !== undefined ? plainText(node.value) : text;
      }
    };

    return render(parseMarkdown(markdown)).trim();
  };

  const fieldsText = (
    fields: Record<string, DatabaseField>,
    prefix = "",
  ): string[] =>
    Object.entries(fields).flatMap(([key, field]) => [
      plainText(
        `${prefix}${key}: ${field.label} (${field.dataType}${field.primaryKey ? ", primary key" : ""}${field.nullable ? ", nullable" : ""})${field.references ? ` → ${field.references.store}.${field.references.collection}.${field.references.field}` : ""}`,
      ),
      ...fieldsText(field.fields ?? {}, `${prefix}${key}.`),
    ]);

  const renderBlock = (block: Block): string => {
    switch (block.type) {
      case "section":
        return [prose(block.title), ...block.children.map(renderBlock)].join(
          "\n\n",
        );
      case "callout":
        return [
          `${block.tone.toUpperCase()}${block.title ? `: ${prose(block.title)}` : ""}`,
          ...block.children.map(renderBlock),
        ].join("\n\n");
      case "markdown":
        return prose(block.markdown, block.pins);
      case "code":
        return [
          prose(block.caption ?? ""),
          `Code (${plainText(block.language)}):`,
          plainText(block.text),
        ]
          .filter(Boolean)
          .join("\n");
      case "code_peek":
        return [
          prose(block.caption ?? ""),
          `Code reference: ${selectionText(block.source)}`,
        ]
          .filter(Boolean)
          .join("\n");
      case "sequence":
        return [
          `Sequence: ${prose(block.title)}`,
          ...block.steps.map((step) =>
            [
              `${prose(block.actors[step.from] ?? step.from)} → ${prose(block.actors[step.to] ?? step.to)}: ${prose(step.label)} (${step.style})`,
              ...(step.explanation ? [prose(step.explanation)] : []),
              ...(step.source ? [selectionText(step.source)] : []),
              ...(step.code
                ? [
                    `Code (${plainText(step.code.language)}):\n${plainText(step.code.text)}`,
                  ]
                : []),
            ].join("\n"),
          ),
        ].join("\n\n");
      case "flow_diagram": {
        const labels = new Map(
          block.nodes.map((node) => [node.key, prose(node.label)]),
        );

        return [
          `Flow: ${prose(block.title)}`,
          prose(block.description ?? ""),
          ...block.nodes.map((node) =>
            [
              `${labels.get(node.key)}${node.kind ? ` (${node.kind})` : ""}`,
              prose(node.description ?? ""),
              ...node.attachments.map(
                (attachment) =>
                  `${prose(attachment.label)}: ${attachment.sources.map(selectionText).join("; ")}`,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          ...block.edges.map(
            (edge) =>
              `${labels.get(edge.from) ?? plainText(edge.from)} → ${labels.get(edge.to) ?? plainText(edge.to)}${edge.label ? `: ${prose(edge.label)}` : ""}${edge.style === "dashed" ? " (dashed)" : ""}`,
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
      }

      case "call_stack_diff":
        return [
          `Call stack comparison: ${prose(block.title)}`,
          ...(["base", "head"] as const).map((side) => {
            const frames = block[side];

            return [
              `${side.toUpperCase()}:`,
              ...frames.map((frame, index) => {
                const parent =
                  frame.parentKey === undefined
                    ? frames[index - 1]
                    : frames.find(
                        (candidate) => candidate.key === frame.parentKey,
                      );

                const label = prose(
                  frame.label ?? frame.key ?? frame.source.file,
                );

                return [
                  parent
                    ? `${prose(parent.label ?? parent.key ?? parent.source.file)} → ${label}`
                    : label,
                  selectionText(frame.source),
                  ...(frame.via
                    ? [`${frame.via.kind}: ${prose(frame.via.reason)}`]
                    : []),
                  ...(frame.callSite
                    ? [`Call site: ${selectionText(frame.callSite)}`]
                    : []),
                  ...(frame.contextSources ?? []).map(
                    (source) => `Context: ${selectionText(source)}`,
                  ),
                ].join("\n");
              }),
              ...(frames.length ? [] : ["(No frames)"]),
            ].join("\n\n");
          }),
        ].join("\n\n");
      case "database_lens":
        return [
          `Database: ${prose(block.title)}`,
          ...Object.values(block.stores).flatMap((store) => [
            `${prose(store.label)} (${store.storage})`,
            ...Object.values(store.collections).flatMap((collection) => [
              prose(collection.label),
              ...fieldsText(collection.fields),
            ]),
          ]),
          ...block.useCases.flatMap((useCase) => [
            `Use case: ${prose(useCase.label)}`,
            prose(useCase.summary ?? ""),
            ...useCase.operations.map((operation) => {
              const actor = block.actors[operation.actor];

              const actorLabel = isStringValue(actor)
                ? actor
                : (actor?.label ?? operation.actor);

              const store = block.stores[operation.store];
              const collection = store?.collections[operation.collection];

              return [
                `${prose(actorLabel)} ${operation.kind === "read" ? "reads from" : "writes to"} ${prose(store?.label ?? operation.store)}.${prose(collection?.label ?? operation.collection)}${operation.field ? `.${plainText(operation.field)}` : ""}: ${prose(operation.label)}`,
                prose(operation.detail ?? ""),
                selectionText(operation.source),
              ]
                .filter(Boolean)
                .join("\n");
            }),
          ]),
        ]
          .filter(Boolean)
          .join("\n\n");
      case "image":
        return [
          `Image: ${prose(block.alt)} (not embedded)`,
          prose(block.caption ?? ""),
        ]
          .filter(Boolean)
          .join("\n");
      case "software_map":
        return `Software map${block.focusElementId ? ` (focus: ${plainText(block.focusElementId)})` : ""}: open the attached review to explore the map. Map resources are not included in this text preview.`;
      case "trace_quote":
        return traceOmitted;
      case "tutorial":
        switch (block.kind) {
          case "feature":
            return block.children.map(renderBlock).join("\n\n");
          case "conversation":
            return "[Conversation omitted for privacy.]";
          case "view":
            return `${prose(block.label)}: open the attached review.`;
          case "keymap":
            return "Open the attached review for keyboard shortcuts.";
        }

        break;
      case "divider":
        return "—";
    }
  };

  const messages: AttachmentMessage[] = [];

  const collect = (blocks: Block[], subject: string) => {
    let content: string[] = [];

    const flush = () => {
      if (content.length)
        messages.push({ subject, body: content.join("\n\n") });
      content = [];
    };

    for (const block of blocks) {
      if (block.type === "section") {
        flush();
        collect(
          block.children,
          subject ? `${subject} / ${prose(block.title)}` : prose(block.title),
        );
      } else {
        const body = renderBlock(block);

        if (body) content.push(body);
      }
    }

    flush();
  };

  collect(snapshot.document, "");

  if (!messages.length)
    messages.push({ body: "No authored content in this review." });
  const fullTitle = prose(snapshot.title) || "Whiteboard review";

  const title =
    fullTitle.length > 200 ? `${fullTitle.slice(0, 199)}…` : fullTitle;

  return {
    title,
    subtitle: `Review · version ${snapshot.version}`,
    url,
    metadata: {
      title,
      messages: limitMessages(messages),
      attributes: [
        { name: "Review", value: plainText(snapshot.reviewId) },
        { name: "Version", value: String(snapshot.version) },
        ...(snapshot.pins
          ? [
              { name: "Base commit", value: plainText(snapshot.pins.base) },
              { name: "Head commit", value: plainText(snapshot.pins.head) },
            ]
          : []),
        ...(origin.success
          ? [{ name: "Pull request", value: origin.data }]
          : []),
        {
          name: "Preview",
          value: "Text only; open the attached review for interactive views.",
        },
        {
          name: "Privacy",
          value:
            "Trace quotes and conversations are omitted. No external resources are fetched.",
        },
      ],
    },
  };
}
