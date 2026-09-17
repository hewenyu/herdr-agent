import type { AppConfig } from "../config/types.js";
import { OperationError } from "../core/errors.js";
import type { HerdrPort, PlatformPort } from "../core/ports.js";
import type { Participant, Task, TranscriptEntry } from "../core/types.js";
import type { ProjectCatalog } from "../projects/catalog.js";
import type { Operations } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import type { TaskRecords } from "./records.js";

export interface TaskHooks {
  changed?(task: Task): void;
  output?(task: Task, participant: Participant, entry: TranscriptEntry): Promise<void>;
  notice?(task: Task, kind: "welcome" | "group_ready" | "progress" | "before_close"): Promise<void>;
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
