import assert from "node:assert/strict";
import type { TestContext } from "node:test";

/** Minimal DOM port for client event tests; real rendering/accessibility is checked in Chrome. */
export class Element {
  children: Element[] = [];
  className = "";
  id = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  checked = false;
  required = false;
  readOnly = false;
  attributes = new Map<string, string>();
  private text = "";
  private listeners = new Map<string, Array<() => unknown>>();

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  append(...children: Element[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: Element[]) {
    this.text = "";
    this.children = children;
  }

  contains(target: Element): boolean {
    return this === target || this.children.some((child) => child.contains(target));
  }

  querySelector<T = Element>(selector: string): T | null {
    return (this.querySelectorAll(selector)[0] as T | undefined) ?? null;
  }

  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => {
      const match = selector.startsWith("#")
        ? child.id === selector.slice(1)
        : selector.startsWith(".")
          ? child.className.split(" ").includes(selector.slice(1))
          : child.tagName === selector;
      return [...(match ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(event: string, callback: () => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  async click() {
    for (const callback of this.listeners.get("click") ?? []) await callback();
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  reportValidity() {
    return !this.required || Boolean(this.value);
  }
}

class InputElement extends Element {}

export function domFixture(t: TestContext) {
  const root = new Element("document");
  const dialog = new Element("dialog");
  dialog.id = "modal";
  const content = new Element("div");
  content.id = "modal-content";
  dialog.append(content);
  root.append(dialog);
  const document = {
    createElement: (tag: string) => (tag === "input" ? new InputElement(tag) : new Element(tag)),
    createTextNode: (text: string) => {
      const node = new Element("#text");
      node.textContent = text;
      return node;
    },
    querySelector: (selector: string) => root.querySelector(selector),
  };
  for (const [key, value] of Object.entries({ document, HTMLInputElement: InputElement })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { root, dialog, content };
}

export function find(root: Element | HTMLElement, selector: string): Element {
  const result = (root as Element).querySelector(selector);
  assert.ok(result, `Missing ${selector}`);
  return result;
}

export function buttonNamed(root: Element | HTMLElement, label: string): Element {
  const result = (root as Element)
    .querySelectorAll("button")
    .find((node) => node.textContent === label);
  assert.ok(result, `Missing button ${label}`);
  return result;
}
