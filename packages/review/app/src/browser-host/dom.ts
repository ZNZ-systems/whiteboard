export function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (text !== undefined) node.textContent = text;

  if (className) node.className = className;

  return node;
}

export function createWidget(container: HTMLElement, title: string) {
  const document = container.ownerDocument;
  const root = element(document, "section", undefined, "browser-review-widget");
  root.setAttribute("aria-label", title);
  root.tabIndex = 0;
  const heading = element(document, "div", title, "browser-review-heading");
  const body = element(document, "div", undefined, "browser-review-body");
  root.append(heading, body);
  container.append(root);
  const abort = new AbortController();
  const errors = new Set<(message: string) => void>();
  const heights = new Set<(height: number) => void>();
  let error: string | undefined;
  const height = () => Math.ceil(root.getBoundingClientRect().height);

  const resize = new ResizeObserver(() => {
    for (const listener of heights) listener(height());
  });

  resize.observe(root);

  return {
    root,
    heading,
    body,
    document,
    abort,
    height,
    status(text: string, failed = false) {
      if (!failed) error = undefined;
      const status = element(document, "p", text, "browser-review-status");
      status.setAttribute("role", failed ? "alert" : "status");
      body.replaceChildren(status);
      root.setAttribute("aria-busy", String(!failed));
    },
    fail(cause: unknown) {
      if (abort.signal.aborted) return;
      error = cause instanceof Error ? cause.message : String(cause);
      this.status(error, true);

      for (const listener of errors) listener(error);
    },
    onDidError(listener: (message: string) => void) {
      errors.add(listener);

      if (error) listener(error);

      return {
        dispose: () => {
          errors.delete(listener);
        },
      };
    },
    onDidChangeHeight(listener: (height: number) => void) {
      heights.add(listener);

      return {
        dispose: () => {
          heights.delete(listener);
        },
      };
    },
    dispose() {
      abort.abort();
      resize.disconnect();
      errors.clear();
      heights.clear();
      root.remove();
    },
  };
}
