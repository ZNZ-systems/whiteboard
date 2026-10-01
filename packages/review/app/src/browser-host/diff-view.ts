import type {
  ReviewDiffLens,
  ReviewDiffViewFactory,
} from "@dev.fast/review-protocol";

import { createWidget, element } from "./dom";
import { type SourceClient, patchRows } from "./source";

export function createDiffViews(source: SourceClient): ReviewDiffViewFactory {
  return {
    files: (scope) => source.files(scope),
    create(spec) {
      const widget = createWidget(
        spec.container,
        spec.lens?.title ?? "Changed files",
      );

      const { root, document, body } = widget;

      if (spec.document) {
        root.dataset.heightMode = spec.document.heightMode;
        widget.onDidChangeHeight(spec.document.onDidChangeHeight);
        root.addEventListener("focusin", () => spec.document?.onDidFocus?.());
      }

      const navigation = element(
        document,
        "nav",
        undefined,
        "browser-review-files",
      );

      navigation.setAttribute("aria-label", "Changed files");

      if (spec.fileTreeContainer) spec.fileTreeContainer.append(navigation);
      else root.insertBefore(navigation, body);
      const buttons = new Map<string, HTMLButtonElement>();
      const scrollListeners = new Set<(viewport: { height: number }) => void>();

      const notifyScroll = () => {
        for (const listener of scrollListeners)
          listener({ height: body.clientHeight });
      };

      body.addEventListener("scroll", notifyScroll);
      let selection: ReviewDiffLens["ranges"][number] | undefined;
      let requestedFile: string | undefined;
      let selectedFile: string | undefined;
      let loading: AbortController | undefined;
      let loaded = false;

      const selectRange = () => {
        let target: HTMLElement | undefined;

        const ranges = selection
          ? [selection]
          : (spec.lens?.ranges.filter((range) => range.file === selectedFile) ??
            []);

        for (const row of body.querySelectorAll<HTMLElement>("tr")) {
          const selected = ranges.some((range) => {
            const line = Number(row.dataset[range.side]);

            return line >= range.fromLine && line <= range.toLine;
          });

          row.dataset.selected = String(selected);

          if (selected && !target) target = row;
        }

        target?.scrollIntoView({ block: "nearest", inline: "nearest" });
      };

      const show = async (path: string) => {
        requestedFile = path;

        if (!loaded) return;

        if (selectedFile === path) {
          selectRange();

          return;
        }

        if (!buttons.has(path)) {
          loading?.abort();
          selectedFile = undefined;
          widget.fail(
            new Error(`No changes for ${path} in this saved review.`),
          );

          return;
        }

        loading?.abort();
        const current = new AbortController();
        loading = current;
        const signal = AbortSignal.any([widget.abort.signal, current.signal]);
        selectedFile = path;
        widget.heading.textContent = `${path} — saved diff`;

        for (const [file, button] of buttons)
          button.setAttribute("aria-current", String(file === path));
        widget.status("Loading diff…");

        try {
          const patch = await source.patch(path, spec.scope, signal);

          if (signal.aborted) return;

          const table = element(
            document,
            "table",
            undefined,
            "browser-review-code",
          );

          table.setAttribute(
            "aria-label",
            `${path} diff; base and head line numbers`,
          );
          const thead = element(document, "thead");
          const header = element(document, "tr");

          for (const label of ["Base", "Head", "Change"]) {
            const cell = element(document, "th", label);
            cell.scope = "col";
            header.append(cell);
          }

          thead.append(header);
          const tbody = element(document, "tbody");

          for (const row of patchRows(patch)) {
            const tr = element(document, "tr");
            tr.dataset.kind = row.kind;

            for (const side of ["base", "head"] as const) {
              const line = row[side];

              if (line !== undefined) tr.dataset[side] = String(line);

              const number = element(
                document,
                "th",
                line === undefined ? "" : String(line),
              );

              number.scope = "row";

              if (line !== undefined)
                number.setAttribute("aria-label", `${side} line ${line}`);
              tr.append(number);
            }

            const cell = element(document, "td");
            cell.append(element(document, "code", row.text));
            tr.append(cell);
            tbody.append(tr);
          }

          table.append(thead, tbody);
          body.replaceChildren(
            patch
              ? table
              : element(document, "p", "No textual changes for this file."),
          );
          root.setAttribute("aria-busy", "false");
          selectRange();
          notifyScroll();
        } catch (cause) {
          if (!signal.aborted) {
            selectedFile = undefined;
            widget.fail(cause);
          }
        }
      };

      widget.status("Loading changed files…");
      void source
        .files(spec.scope, widget.abort.signal)
        .then((files) => {
          if (widget.abort.signal.aborted) return;

          const paths = spec.lens
            ? new Set(spec.lens.ranges.map((range) => range.file))
            : undefined;

          const visible = files.filter(
            (file) =>
              !paths ||
              paths.has(file.path) ||
              (file.previousPath && paths.has(file.previousPath)),
          );

          for (const file of visible) {
            const button = element(
              document,
              "button",
              `${file.path} (+${file.additions} −${file.deletions})${file.binary ? " · binary" : ""}`,
            );

            button.type = "button";
            button.addEventListener("click", () => {
              selection = undefined;
              void show(file.path);
            });
            navigation.append(button);
            buttons.set(file.path, button);
          }

          loaded = true;

          if (requestedFile) void show(requestedFile);
          else if (visible[0]) void show(visible[0].path);
          else {
            body.replaceChildren(
              element(
                document,
                "p",
                "No changed files in this saved comparison.",
                "browser-review-status",
              ),
            );
            root.setAttribute("aria-busy", "false");
          }
        })
        .catch((cause: unknown) => widget.fail(cause));

      return {
        focus: () => root.focus(),
        onDidError: widget.onDidError,
        revealFile: (path) => {
          selection = undefined;
          void show(path);
        },
        revealSource: (range) => {
          selection = range;
          void show(range.file);
        },
        onDidScroll(listener) {
          scrollListeners.add(listener);

          return {
            dispose: () => {
              scrollListeners.delete(listener);
            },
          };
        },
        sourceOffset(range) {
          if (range.file !== selectedFile) return undefined;

          const row = [...body.querySelectorAll<HTMLElement>("tr")].find(
            (row) => {
              const line = Number(row.dataset[range.side]);

              return line >= range.fromLine && line <= range.toLine;
            },
          );

          return row
            ? row.getBoundingClientRect().top - body.getBoundingClientRect().top
            : undefined;
        },
        dispose() {
          loading?.abort();
          scrollListeners.clear();
          navigation.remove();
          widget.dispose();
        },
      };
    },
  };
}
