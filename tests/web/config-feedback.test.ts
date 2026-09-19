import assert from "node:assert/strict";
import test from "node:test";
import type { Action } from "../../src/web/client/api.js";
import { configurationAction } from "../../src/web/client/config-action.js";
import { closeModal } from "../../src/web/client/dom.js";
import { renderProjects, renderSettings } from "../../src/web/client/projects.js";
import { buttonNamed, domFixture, find } from "./dom-fixture.js";

function config(dispatch: Action) {
  const notices: Array<{ message: string; error?: boolean }> = [];
  let refreshes = 0;
  return {
    notices,
    refreshes: () => refreshes,
    action: configurationAction(
      dispatch,
      async () => {
        refreshes++;
      },
      (message, error) => notices.push({ message, error }),
    ),
  };
}

const project = { name: "demo", directories: ["/project"], agent: "codex" as const };

test("add project errors stay inside the dialog, preserve input and clear on retry/success", async (t) => {
  const { dialog } = domFixture(t);
  let succeed: ((value: Record<string, unknown>) => void) | undefined;
  const calls: Record<string, unknown>[] = [];
  const error = '目录不存在：/missing/<img src=x onerror="alert(1)">';
  const operation = config(async (_name, input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error(error);
    return new Promise((resolve) => {
      succeed = resolve;
    });
  });
  const page = renderProjects({}, operation.action);
  await buttonNamed(page, "＋ 添加项目").click();
  const name = find(dialog, "input");
  const directories = find(dialog, "textarea");
  name.value = "demo";
  directories.value = "/project\n/missing";
  const save = buttonNamed(dialog, "保存项目");
  await save.click();
  const notice = find(dialog, ".modal-feedback");
  assert.equal(dialog.open, true);
  assert.equal(notice.attributes.get("role"), "alert");
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, error);
  assert.deepEqual(notice.children, []);
  assert.equal(find(dialog, "textarea"), directories);
  assert.equal(directories.value, "/project\n/missing");
  assert.equal(name.value, "demo");
  assert.equal(save.disabled, false);
  assert.equal(operation.notices.length, 0);
  assert.equal(operation.refreshes(), 0);

  directories.value = "/project\n/valid";
  const pending = save.click();
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, "");
  assert.equal(save.disabled, true);
  assert.ok(succeed);
  succeed({ saved: true });
  await pending;
  assert.equal(dialog.open, false);
  assert.deepEqual(calls[1]?.directories, ["/project", "/valid"]);
  assert.equal(operation.refreshes(), 1);
  assert.equal(operation.notices[0]?.message, "配置已保存。");
  await buttonNamed(page, "＋ 添加项目").click();
  assert.equal(dialog.querySelectorAll(".modal-feedback").length, 1);
  assert.equal(find(dialog, ".modal-feedback").hidden, true);
  assert.equal(find(dialog, ".modal-feedback").textContent, "");
});

test("editing preserves changed directories and replaces repeated error feedback", async (t) => {
  const { dialog } = domFixture(t);
  let attempts = 0;
  const operation = config(async () => {
    throw new Error(`保存失败 ${++attempts}`);
  });
  const page = renderProjects({ projects: [project] }, operation.action);
  await buttonNamed(page, "编辑").click();
  assert.equal(find(dialog, "input").readOnly, true);
  const directories = find(dialog, "textarea");
  directories.value = "/project\n/invalid";
  await buttonNamed(dialog, "保存项目").click();
  await buttonNamed(dialog, "保存项目").click();
  assert.equal(dialog.open, true);
  assert.equal(directories.value, "/project\n/invalid");
  assert.equal(find(dialog, ".modal-feedback").textContent, "保存失败 2");
  assert.equal(dialog.querySelectorAll(".modal-feedback").length, 1);
  await buttonNamed(dialog, "取消").click();
  await buttonNamed(page, "编辑").click();
  assert.equal(find(dialog, ".modal-feedback").textContent, "");
  assert.equal(find(dialog, ".modal-feedback").hidden, true);
  assert.equal(find(dialog, "textarea").value, "/project");
});

test("late configuration failure or success cannot overwrite or close a newer dialog", async (t) => {
  const { dialog } = domFixture(t);
  for (const succeeds of [false, true]) {
    let resolve: ((value: Record<string, unknown>) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const operation = config(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const page = renderProjects({ projects: [project] }, operation.action);
    await buttonNamed(page, "编辑").click();
    const pending = buttonNamed(dialog, "保存项目").click();
    closeModal();
    await buttonNamed(page, "＋ 添加项目").click();
    const newName = find(dialog, "input");
    newName.value = "different project";
    assert.ok(resolve && reject);
    if (succeeds) resolve({ saved: true });
    else reject(new Error("旧弹窗的请求失败"));
    await pending;
    assert.equal(dialog.open, true);
    assert.equal(find(dialog, "input"), newName);
    assert.equal(newName.value, "different project");
    assert.equal(find(dialog, ".modal-feedback").textContent, "");
    assert.equal(find(dialog, ".modal-feedback").hidden, true);
    assert.equal(
      operation.notices.some((notice) => notice.error),
      false,
    );
  }
});

test("delete and Bypass confirmations show errors locally and close only after success", async (t) => {
  const { dialog } = domFixture(t);
  for (const action of ["project.delete", "catalog.bypass"]) {
    let attempts = 0;
    const operation = config(async (name) => {
      assert.equal(name, action);
      if (++attempts === 1) throw new Error("当前状态不允许修改");
      return {};
    });
    const page = renderProjects({ projects: [project] }, operation.action);
    if (action === "project.delete") await buttonNamed(page, "删除配置").click();
    else {
      find(page, "input").checked = true;
      await buttonNamed(page, "保存模式").click();
    }
    await buttonNamed(dialog, "确认").click();
    assert.equal(dialog.open, true);
    assert.equal(find(dialog, ".modal-feedback").textContent, "当前状态不允许修改");
    assert.deepEqual(operation.notices, []);
    await buttonNamed(dialog, "确认").click();
    assert.equal(dialog.open, false);
    assert.equal(find(dialog, ".modal-feedback").hidden, true);
  }
});

test("model configuration still reports errors on the page and preserves entered values", async (t) => {
  domFixture(t);
  const operation = config(async (name, input) => {
    assert.equal(name, "config.ai");
    assert.equal(input.baseUrl, "invalid-url");
    throw new Error("请输入有效的模型地址");
  });
  const page = renderSettings({}, operation.action);
  const label = [...page.children].find((child) => child.textContent?.startsWith("Base URL"));
  assert.ok(label);
  const url = find(label as HTMLElement, "input");
  url.value = "invalid-url";
  await buttonNamed(page, "保存模型连接").click();
  assert.equal(url.value, "invalid-url");
  assert.deepEqual(operation.notices, [{ message: "请输入有效的模型地址", error: true }]);
});
