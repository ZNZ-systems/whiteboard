import type {
  ReviewInlineEditorFactory,
  ReviewInlineEditorSpec,
} from "@dev.fast/review-protocol";

import { createWidget, element } from "./dom";
import {
  type SourceClient,
  type SourceMatch,
  type SourceRow,
  findSource,
} from "./source";

export function createInlineEditors(
  source: SourceClient,
  open: (spec: ReviewInlineEditorSpec) => void,
): ReviewInlineEditorFactory {
  return {
    async find(spec, query) {
      return { matchCount: findSource(await source.rows(spec), query).length };
    },
    create(spec) {
      const widget = createWidget(spec.container, spec.title);
      const { document, root, body } = widget;
      root.dataset.heightMode = spec.heightMode;

      if (spec.description)
        widget.heading.append(element(document, "small", spec.description));
      const openButton = element(document, "button", "Open source");
      openButton.type = "button";
      openButton.addEventListener("click", () => {
        spec.onDidOpen?.();
        open(spec);
      });
      widget.heading.append(openButton);
      root.addEventListener("focusin", () => spec.onDidFocus?.());
      let rows: SourceRow[] = [];
      let matches: SourceMatch[] = [];
      let active = -1;
      const marks: HTMLElement[] = [];

      const render = () => {
        marks.length = 0;

        const table = element(
          document,
          "table",
          undefined,
          "browser-review-code",
        );

        table.setAttribute("aria-label", `${spec.path} source`);
        const tbody = element(document, "tbody");

        for (const [index, row] of rows.entries()) {
          if (row.gap) {
            const gap = element(document, "tr");
            const cell = element(document, "td", "… lines omitted …");
            cell.colSpan = 2;
            gap.append(cell);
            tbody.append(gap);
          }

          const tr = element(document, "tr");
          tr.dataset.line = String(row.line);
          tr.dataset.side = row.side;
          tr.dataset.selected = String(row.selected);
          const number = element(document, "th", `${row.side} ${row.line}`);
          number.scope = "row";
          number.setAttribute(
            "aria-label",
            `${row.side} line ${row.line}${row.selected ? ", selected" : ""}`,
          );
          const cell = element(document, "td");
          const code = element(document, "code");
          let offset = 0;

          for (const [matchIndex, match] of matches.entries()) {
            if (match.row !== index) continue;
            code.append(
              element(document, "span", row.text.slice(offset, match.start)),
            );

            const mark = element(
              document,
              "mark",
              row.text.slice(match.start, match.end),
            );

            mark.dataset.active = String(matchIndex === active);
            marks.push(mark);
            code.append(mark);
            offset = match.end;
          }

          code.append(
            element(
              document,
              "span",
              row.text.slice(offset) || (row.text ? "" : " "),
            ),
          );
          cell.append(code);
          tr.append(number, cell);
          tbody.append(tr);
        }

        table.append(tbody);
        body.replaceChildren(
          rows.length ? table : element(document, "p", "This file is empty."),
        );
        root.setAttribute("aria-busy", "false");
      };

      widget.status("Loading source…");

      const ready = source.rows(spec, widget.abort.signal).then((loaded) => {
        if (widget.abort.signal.aborted) return;
        rows = loaded;
        render();
      });

      void ready.catch((cause: unknown) => widget.fail(cause));
      root.dataset.active = String(spec.active);

      return {
        get height() {
          return widget.height();
        },
        setActive(active) {
          root.dataset.active = String(active);
        },
        setCollapsed(collapsed) {
          root.hidden = collapsed;
        },
        onDidChangeHeight: widget.onDidChangeHeight,
        onDidError: widget.onDidError,
        async setFindQuery(query) {
          await ready;

          if (widget.abort.signal.aborted) return { matchCount: 0 };
          matches = findSource(rows, query);
          active = -1;
          render();

          return { matchCount: matches.length };
        },
        revealFindMatch(index) {
          active = index;

          for (const [i, mark] of marks.entries())
            mark.dataset.active = String(i === active);
          marks[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
        },
        clearActiveFindMatch() {
          active = -1;

          for (const mark of marks) mark.dataset.active = "false";
        },
        clearFind() {
          matches = [];
          active = -1;

          if (!widget.abort.signal.aborted) render();
        },
        dispose: widget.dispose,
      };
    },
  };
}
