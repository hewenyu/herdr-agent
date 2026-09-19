export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, run: () => void | Promise<void>, className = "") {
  const node = el("button", `button ${className}`, label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await run();
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

export function actions(...children: HTMLElement[]): HTMLDivElement {
  const node = el("div", "actions");
  node.append(...children);
  return node;
}

export function field(
  label: string,
  value = "",
  type: "text" | "textarea" | "password" | "number" = "text",
  hint?: string,
) {
  const wrapper = el("label", "field");
  wrapper.append(el("span", "field-label", label));
  const input = type === "textarea" ? el("textarea") : el("input");
  if (input instanceof HTMLInputElement) input.type = type;
  input.value = value;
  wrapper.append(input);
  if (hint) wrapper.append(el("small", "subtle", hint));
  return { wrapper, input };
}

export function check(label: string, checked = false) {
  const wrapper = el("label", "check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  wrapper.append(input, document.createTextNode(label));
  return { wrapper, input };
}

export function heading(title: string, subtitle: string, ...buttons: HTMLElement[]) {
  const wrapper = el("div", "section-head");
  const text = el("div");
  text.append(el("h2", "", title), el("p", "subtle", subtitle));
  wrapper.append(text, actions(...buttons));
  return wrapper;
}

export function modal(title: string): HTMLDivElement {
  const dialog = document.querySelector<HTMLDialogElement>("#modal");
  const content = document.querySelector<HTMLDivElement>("#modal-content");
  if (!dialog || !content) throw new Error("缺少对话框");
  const body = el("div");
  content.replaceChildren(body);
  const head = el("div", "modal-head");
  head.append(
    el("h2", "", title),
    button("×", () => dialog.close(), "icon-button"),
  );
  const feedback = el("div", "notice error modal-feedback");
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;
  body.append(head, feedback);
  if (!dialog.open) dialog.showModal();
  return body;
}

export function closeModal(body?: HTMLElement): void {
  if (body && !document.querySelector("#modal-content")?.contains(body)) return;
  document.querySelector<HTMLDialogElement>("#modal")?.close();
}

/** Capture this dialog's feedback, so a late response cannot affect a newer dialog. */
export function modalFeedback(): ((message?: string) => void) | undefined {
  const dialog = document.querySelector<HTMLDialogElement>("#modal");
  const feedback = dialog?.querySelector<HTMLElement>(".modal-feedback");
  if (!dialog?.open || !feedback) return;
  return (message = "") => {
    if (!dialog.open || !dialog.contains(feedback)) return;
    feedback.textContent = message;
    feedback.hidden = !message;
  };
}

export function ask(title: string, detail: string, run: () => Promise<boolean>) {
  const body = modal(title);
  body.append(el("p", "details", detail));
  body.append(
    actions(
      button("取消", closeModal),
      button(
        "确认",
        async () => {
          if (await run()) closeModal(body);
        },
        "danger",
      ),
    ),
  );
}

export function select(label: string, options: Array<[string, string]>, value?: string) {
  const wrapper = el("label", "field");
  wrapper.append(el("span", "field-label", label));
  const input = el("select");
  for (const [key, text] of options) {
    const option = el("option", "", text);
    option.value = key;
    input.append(option);
  }
  if (value !== undefined) input.value = value;
  wrapper.append(input);
  return { wrapper, input };
}

export function empty(title: string, detail: string) {
  const node = el("div", "empty");
  node.append(el("strong", "", title), el("p", "", detail));
  return node;
}

export function time(value?: string) {
  if (!value) return "时间未记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : value;
}

export function detail(label: string, value: unknown, id: string) {
  const node = el("details", "record-detail");
  node.dataset.recordId = id;
  node.append(
    el("summary", "", label),
    el("pre", "record-data", typeof value === "string" ? value : JSON.stringify(value, null, 2)),
  );
  return node;
}
