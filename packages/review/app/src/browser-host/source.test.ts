import { expect, it } from "vitest";

import { findSource, patchRows, sourceRows } from "./source";

it("maps disjoint source ranges to original line numbers with merged context", () => {
  const text =
    Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\r\n") + "\r\n";

  const rows = sourceRows(
    text,
    {
      path: "sample.ts",
      side: "head",
      ranges: [
        { startLine: 5, endLine: 6 },
        { startLine: 20, endLine: 21 },
        { startLine: 2, endLine: 3, side: "base" },
      ],
    },
    "head",
  );

  expect(rows.filter((row) => row.selected).map((row) => row.line)).toEqual([
    5, 6, 20, 21,
  ]);
  expect(rows[0]).toMatchObject({ line: 2, text: "line 2", gap: false });
  expect(rows.find((row) => row.line === 17)).toMatchObject({
    gap: true,
    selected: false,
  });
  expect(rows.filter((row) => row.line === 6)).toHaveLength(1);
  expect(rows.at(-1)?.line).toBe(24);
});

it("reports selections that are unavailable instead of silently showing unrelated lines", () => {
  expect(() =>
    sourceRows(
      "only one line\n",
      {
        path: "small.ts",
        side: "base",
        ranges: [{ startLine: 40, endLine: 42 }],
      },
      "base",
    ),
  ).toThrow("Selected base lines are unavailable");
  expect(
    sourceRows("", { path: "empty", side: "head", ranges: [] }, "head"),
  ).toEqual([]);
});

it("finds literal, whole-word, case-sensitive and regex matches in displayed source", () => {
  const rows = sourceRows(
    "run runner RUN\nreturn run();\n",
    { path: "code.ts", side: "head", ranges: [] },
    "head",
  );

  const query = {
    text: "run",
    isRegex: false,
    wholeWord: false,
    matchCase: false,
  };

  expect(findSource(rows, query)).toHaveLength(4);
  expect(
    findSource(rows, { ...query, wholeWord: true, matchCase: true }),
  ).toEqual([
    { row: 0, start: 0, end: 3 },
    { row: 1, start: 7, end: 10 },
  ]);
  expect(
    findSource(rows, { ...query, isRegex: true, text: "run\\(\\)" }),
  ).toEqual([{ row: 1, start: 7, end: 12 }]);
  expect(findSource(rows, { ...query, text: "(" })).toHaveLength(1);
  expect(() =>
    findSource(rows, { ...query, isRegex: true, text: "(" }),
  ).toThrow(/regular expression/i);
});

it("maps the API's numbered patch to base and head rows without confusing code for gutters", () => {
  expect(
    patchRows(
      "diff --git a/code.ts b/code.ts\n@@ -9,2 +9,2 @@\n 9  9  unchanged\n10    -old()\n   10 +new()\n",
    ),
  ).toEqual([
    { kind: "meta", text: "diff --git a/code.ts b/code.ts" },
    { kind: "meta", text: "@@ -9,2 +9,2 @@" },
    { base: 9, head: 9, kind: "context", text: " unchanged" },
    { base: 10, head: undefined, kind: "removed", text: "-old()" },
    { base: undefined, head: 10, kind: "added", text: "+new()" },
  ]);
});
