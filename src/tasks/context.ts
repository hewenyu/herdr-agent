import type { AppConfig } from "../config/types.js";
import { OperationError } from "../core/errors.js";
import type { HerdrPort, PlatformPort } from "../core/ports.js";
import type { Participant, Task, TranscriptEntry } from "../core/types.js";
import type { ProjectCatalog } from "../projects/catalog.js";
import type { Operations } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import type { TaskRecords } from "./records.js";

export interface NoticeUnavailable {
  status: "unavailable";
  reason: "generation_failed";
  errorCode: string;
}

export interface TaskHooks {
  /** Re-observe a blocked menu once when its presentation parser changes. */
  blockedVersion?: string;
  changed?(task: Task): void;
  output?(task: Task, participant: Participant, entry: TranscriptEntry): Promise<void>;
  /** Read-only proof that the existing output envelope is already delivered. */
  outputConfirmed?(task: Task, participant: Participant, entry: TranscriptEntry): boolean;
  /** Read-only proof that re-entering this exact output callback cannot duplicate delivery. */
  outputRetryable?(task: Task, participant: Participant, entry: TranscriptEntry): boolean;
  notice?(
    task: Task,
    kind: "welcome" | "group_ready" | "progress" | "before_close" | "before_group_delete",
  ): Promise<NoticeUnavailable | undefined> | Promise<void>;
  canDeleteGroup?(task: Task): boolean | Promise<boolean>;
  blocked?(task: Task, participant: Participant): Promise<void>;
}

export interface TaskContext {
  signal: AbortSignal;
  config: AppConfig;
  store: Store;
  records: TaskRecords;
  operations: Operations;
  catalog: ProjectCatalog;
  herdr: HerdrPort;
  platform?: PlatformPort;
  hooks: TaskHooks;
}

export function assertActive(context: Pick<TaskContext, "signal">): void {
  if (context.signal.aborted)
    throw new OperationError("stopping", "服务正在停止，尚未开始下一步操作。");
}
