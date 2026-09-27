import { createHash } from "node:crypto";
import { fail } from "../core/errors.js";
import type { Project } from "../core/types.js";

export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const MAX_VERIFY_TIMEOUT_MS = 600_000;

export function validateVerificationConfig(
  project: Pick<Project, "verify" | "verifyTimeoutMs">,
): void {
  if (
    project.verify !== undefined &&
    (!Array.isArray(project.verify) ||
      project.verify.length > 32 ||
      project.verify.some(
        (command) =>
          typeof command !== "string" ||
          !command.trim() ||
          command.includes("\0") ||
          command.length > 16_384,
      ))
  )
    fail(
      "project_verify",
      "verify 必须是至多 32 条非空命令的数组，每条不能包含 NUL 或超过 16384 字符。",
    );
  if (
    project.verifyTimeoutMs !== undefined &&
    (!Number.isInteger(project.verifyTimeoutMs) ||
      project.verifyTimeoutMs < 1 ||
      project.verifyTimeoutMs > MAX_VERIFY_TIMEOUT_MS)
  )
    fail("project_verify_timeout", "验证命令超时必须为 1 到 600000 毫秒的整数。");
}

/** Binds a selection to the local owner's exact command configuration. */
export function verificationConfigRevision(project: Project): string {
  validateVerificationConfig(project);
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: project.name,
        directories: project.directories,
        verify: project.verify ?? [],
        timeoutMs: project.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      }),
    )
    .digest("hex");
}
