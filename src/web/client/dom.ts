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
