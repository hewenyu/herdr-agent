import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskCreateInput } from "../../src/core/types.js";
import type { WorkflowTemplate } from "../../src/orchestration/workflow.js";

export const verificationCommand = "node --test verify.test.mjs";

export async function createFixture(directory: string, template: WorkflowTemplate) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rules = [
    "这是隔离的真实工作流验收项目。只访问本项目和任务看板，不访问其他目录、用户配置、凭据或网络。",
    "不要启动子 agent、后台服务、安装依赖、发消息、提交或推送 Git。不要创建额外项目或参与者。",
    "只完成当前节点的任务；分析、评审和报告阶段不修改项目。",
    template === "discussion"
      ? "仅使用已有两位参与者完成独立开场和交叉评审。"
      : "全程仅使用已有两位参与者：一位实现，另一位负责独立验证与评审。只要求一位未修改代码的独立评审者，不要求两位独立评审者，也不能要求实现者独立评审自身实现。",
    template === "discussion"
      ? "保留 README.md 和 AGENTS.md 原文；无需增添其他文件。"
      : "保留 verify.test.mjs、README.md 和 AGENTS.md 原文；无需增添其他文件。",
    ...(template === "discussion"
      ? ["允许使用只读文件工具或命令读取任务看板；不运行测试或写操作。"]
      : ["可在本项目执行 node --test verify.test.mjs。"]),
    "正文简短、提供真实证据，按任务协议填写完整状态块。",
  ].join("\n");
  await writeFile(join(directory, "AGENTS.md"), `${rules}\n`, { mode: 0o600 });
  const requirements =
    template === "discussion"
      ? "只讨论离线待办清单的默认排序，不开发、不修改任何文件、不运行测试或写操作、不访问网络；允许用只读文件工具或命令读取任务看板。比较 A：未完成优先、创建时间升序；B：未完成优先、截止时间升序，无截止时间放最后。同截止时间按创建时间升序。目标是规则易解释且不遗漏临近截止的任务。两位参与者独立分析后交叉核对，推荐一项并说明权衡；这些信息足够决策，无需追问个人偏好。报告遵守 discussion 模板。"
      : template === "development"
        ? "使用 development 模板完成一个极小纯函数。只修改 index.mjs，实现导出的 sumEven(values)：对有限整数数组中的偶数求和，空数组返回 0，不修改输入数组，支持负数与零。已有 verify.test.mjs 是验收合同，不得修改；不需要其他文件、依赖或用户决定。先分析，再实现、独立验证、独立评审、报告。交付 index.mjs，并在状态块 artifactRefs 引用它。"
        : "使用 bugfix 模板修复 index.mjs 中 clamp(value,min,max) 的错误：三个参数均为有限数且 min<=max，结果必须处于闭区间 [min,max]，区间内原值不变。先运行 node --test verify.test.mjs 取得实际失败证据，定位根因，仅修改 index.mjs，再由未修改代码的另一位参与者独立验证与评审。verify.test.mjs 是验收合同，不得修改；不需要其他文件、依赖或用户决定。交付 index.mjs，并在状态块 artifactRefs 引用它。";
  await writeFile(join(directory, "README.md"), `${requirements}\n`, { mode: 0o600 });
  if (template !== "discussion") {
    const source =
      template === "development"
        ? 'export function sumEven(_values) { throw new Error("not implemented"); }\n'
        : "export function clamp(value, min, max) { return Math.min(min, Math.max(max, value)); }\n";
    const tests =
      template === "development"
        ? `import assert from 'node:assert/strict';
import test from 'node:test';
import { sumEven } from './index.mjs';
test('sumEven satisfies the contract without modifying input', () => {
  assert.equal(sumEven([]), 0);
  assert.equal(sumEven([1, 2, 3, 4, 0]), 6);
  assert.equal(sumEven([-4, -3, -2, 1, 6]), 0);
  assert.equal(sumEven([3, 5, 7]), 0);
  const input = Object.freeze([2, 2, -2]);
  assert.equal(sumEven(input), 2);
  assert.deepEqual(input, [2, 2, -2]);
});
`
        : `import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from './index.mjs';
test('clamp preserves in-range values and includes both bounds', () => {
  assert.equal(clamp(3, 1, 5), 3);
  assert.equal(clamp(-2, 1, 5), 1);
  assert.equal(clamp(9, 1, 5), 5);
  assert.equal(clamp(1, 1, 5), 1);
  assert.equal(clamp(5, 1, 5), 5);
  assert.equal(clamp(-3, -5, -1), -3);
  assert.equal(clamp(8, 2, 2), 2);
});
`;
    await writeFile(join(directory, "index.mjs"), source, { mode: 0o600 });
    await writeFile(join(directory, "verify.test.mjs"), tests, { mode: 0o600 });
  }
  const immutableFiles = ["AGENTS.md", "README.md"];
  if (template !== "discussion") immutableFiles.push("verify.test.mjs");
  const hashes = await fixtureHashes(directory, immutableFiles);
  const input: TaskCreateInput = {
    kind: template === "discussion" ? "discussion" : "development",
    title: `真实本地验收 ${template}`,
    requirements: `${requirements}\n\n${rules}`,
    project: "acceptance",
    directoryMode: "shared",
    createGroup: false,
    createRemoteTask: false,
    participants: [
      { kind: "claude", name: "acceptance-claude" },
      { kind: "codex", name: "acceptance-codex" },
    ],
    orchestration: { mode: "workflow", template },
  };
  return { input, immutableFiles, hashes };
}

export async function fixtureHashes(directory: string, files: string[]) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex"),
      ]),
    ),
  );
}
