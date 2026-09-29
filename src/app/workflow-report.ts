import type { Task } from "../core/types.js";
import { evidenceLabels } from "../orchestration/report.js";
import type { WorkflowState } from "../orchestration/workflow.js";

export function compactReportCard(
  task: Task,
  state: WorkflowState,
  platform = true,
): Record<string, unknown> {
  const summary = state.plan.nodes
    .filter((node) => node.phase === "reporting")
    .map((node) => state.nodes[node.id]?.summary)
    .filter(Boolean)
    .join("\n")
    .slice(0, 600);
  const artifacts = state.artifacts.filter(
    (artifact) => artifact.artifactRevision === state.report?.artifactRevision,
  );
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: `${task.title.slice(0, 100)} · 等待验收` } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            summary,
            artifacts.length
              ? `产物：${artifacts
                  .slice(0, 6)
                  .map((artifact) => artifact.reference)
                  .join("、")
                  .slice(0, 600)}`
              : "",
            `验证来源：${[...new Set(state.evidence.filter((item) => item.artifactRevision === state.report?.artifactRevision).map((item) => evidenceLabels[item.source]))].join("、") || "无命令验证"}`,
            ...(state.deliveryEvidence?.repositories ?? [])
              .slice(0, 3)
              .map((entry) =>
                entry.error
                  ? `代码交付位置：${entry.error}`
                  : [
                      `分支：${entry.branch ?? "未确认"} · 提交：${entry.commit?.slice(0, 12) ?? "未确认"}${entry.dirty ? "（仍有未提交修改）" : ""}`,
                      entry.pr?.url ?? "未取得当前提交对应的 PR 证据",
                    ].join("\n"),
              ),
            platform
              ? "完整报告见 report.md 附件；本机记录页也可下载。交付不代表用户已验收。"
              : "完整报告可在本机记录页下载 report.md。交付不代表用户已验收。",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    },
  };
}
