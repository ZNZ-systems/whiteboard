import {
  ReviewApiClient,
  type ReviewCommitScope,
  ReviewDiffFileSchema,
  type ReviewDiffSide,
  type ReviewFindQuery,
  type ReviewInlineFindSpec,
  type ReviewRuntimeConfig,
} from "@dev.fast/review-protocol";
import { z } from "zod";

const sourceSchema = z.object({
  file: z.string(),
  side: z.enum(["base", "head"]),
  commit: z.string(),
  text: z.string(),
});

export interface SourceRow {
  side: ReviewDiffSide;
  line: number;
  text: string;
  selected: boolean;
  gap: boolean;
}

export interface SourceMatch {
  row: number;
  start: number;
  end: number;
}

export function sourceRows(
  text: string,
  spec: ReviewInlineFindSpec,
  side: ReviewDiffSide,
): SourceRow[] {
  const lines = text.split(/\r?\n/);

  if (lines.at(-1) === "") lines.pop();

  const ranges = spec.ranges.filter(
    (range) => (range.side ?? spec.side) === side,
  );

  if (
    ranges.some(
      (range) => range.startLine > lines.length || range.endLine > lines.length,
    )
  )
    throw new Error(`Selected ${side} lines are unavailable in ${spec.path}.`);
  const rows: SourceRow[] = [];

  for (const [index, text] of lines.entries()) {
    const line = index + 1;

    if (
      ranges.length &&
      !ranges.some(
        (range) => line >= range.startLine - 3 && line <= range.endLine + 3,
      )
    )
      continue;
    rows.push({
      side,
      line,
      text,
      selected: ranges.some(
        (range) => line >= range.startLine && line <= range.endLine,
      ),
      gap: rows.length > 0 && rows.at(-1)!.line !== line - 1,
    });
  }

  return rows;
}

export function findSource(
  rows: readonly SourceRow[],
  query: ReviewFindQuery,
): SourceMatch[] {
  if (!query.text) return [];

  let pattern = query.isRegex
    ? query.text
    : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (query.wholeWord)
    pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  const expression = new RegExp(pattern, query.matchCase ? "gu" : "giu");
  const matches: SourceMatch[] = [];

  for (const [row, source] of rows.entries()) {
    for (const match of source.text.matchAll(expression)) {
      if (!match[0].length) continue;
      matches.push({
        row,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return matches;
}

export function createSourceClient(
  config: ReviewRuntimeConfig,
  version: number,
  request: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const client = new ReviewApiClient(config, request);

  const route = (endpoint: string, params: URLSearchParams) => {
    params.set("version", String(version));

    return `/${encodeURIComponent(config.reviewId)}/${endpoint}?${params}`;
  };

  return {
    async rows(spec: ReviewInlineFindSpec, signal?: AbortSignal) {
      const sides = new Set(
        spec.ranges.map((range) => range.side ?? spec.side),
      );

      if (!sides.size) sides.add(spec.side);

      const groups = await Promise.all(
        [...sides].map(async (side) => {
          const params = new URLSearchParams({ file: spec.path, side });

          if (spec.pins) {
            params.set("repositoryId", spec.pins.repositoryId);
            params.set("head", spec.pins.head);

            if (spec.pins.base) params.set("base", spec.pins.base);
          }

          const source = sourceSchema.parse(
            await client.read(route("file", params), signal),
          );

          if (source.file !== spec.path || source.side !== side)
            throw new Error(
              "The source response does not match the requested file and side.",
            );

          if (source.text.includes("\0"))
            throw new Error("Binary files cannot be displayed as source.");

          return sourceRows(source.text, spec, side);
        }),
      );

      return groups.flat();
    },
    async files(scope?: ReviewCommitScope, signal?: AbortSignal) {
      const params = new URLSearchParams({ format: "files" });

      if (scope) params.set("commit", scope.commit);

      return z
        .array(ReviewDiffFileSchema)
        .parse(await client.read(route("diff", params), signal));
    },
    async patch(file: string, scope?: ReviewCommitScope, signal?: AbortSignal) {
      const params = new URLSearchParams({ file, maxBytes: "500000" });

      if (scope) params.set("commit", scope.commit);

      return (await client.response(route("diff", params), { signal })).text();
    },
  };
}

export type SourceClient = ReturnType<typeof createSourceClient>;

export interface PatchRow {
  base?: number;
  head?: number;
  kind: "added" | "removed" | "context" | "meta";
  text: string;
}

export function patchRows(patch: string): PatchRow[] {
  const lines = patch.split(/\r?\n/);

  if (lines.at(-1) === "") lines.pop();
  let width = 1;

  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (hunk)
      width = Math.max(
        width,
        String(Number(hunk[1]) + Number(hunk[2] ?? 1)).length,
        String(Number(hunk[3]) + Number(hunk[4] ?? 1)).length,
      );
  }

  const numbered = new RegExp(
    `^([ \\d]{${width}}) ([ \\d]{${width}}) ([ +\\-\\\\].*)$`,
  );

  return lines.map((text) => {
    const match = numbered.exec(text);

    if (!match) return { kind: "meta", text };
    const code = match[3]!;

    return {
      base: match[1]!.trim() ? Number(match[1]) : undefined,
      head: match[2]!.trim() ? Number(match[2]) : undefined,
      kind: code.startsWith("+")
        ? "added"
        : code.startsWith("-")
          ? "removed"
          : code.startsWith(" ")
            ? "context"
            : "meta",
      text: code,
    };
  });
}
