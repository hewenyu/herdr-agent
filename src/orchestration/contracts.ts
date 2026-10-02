import type { AppConfig } from "../config/types.js";
import type { safeError } from "../core/errors.js";
import type { Logger } from "../core/ports.js";
import type { ActorContext, Task, TranscriptEntry } from "../core/types.js";
import type { ProjectCatalog } from "../projects/catalog.js";
import type { ConversationEngine, RuntimeTool } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import type { TaskService } from "../tasks/service.js";
import type { WorkflowCandidate } from "./candidates.js";

export interface SettledTaskOutput {
  taskId: string;
  participantId: string;
  entry: TranscriptEntry;
  observedAt: string;
  sequence?: number;
}

export interface OrchestrationDecision {
  action: "continue" | "wait" | "deliver";
  reason: string;
  outputId?: string;
  participantId?: string;
  reportId?: string;
  candidateId?: string;
  source?: "rule" | "jev" | "pi" | "leader";
}

export interface Dispatch {
  nodeId?: string;
  text?: string;
  inputRevision?: string;
  artifactRevision?: string;
  sourceRevision?: string;
  operationId: string;
  participantId: string;
  state: "pending" | "sent" | "failed" | "uncertain";
}

export interface OrchestrationEvent {
  id: string;
  taskId: string;
  trigger: "ready" | "output" | "user_revision";
  outputIds: string[];
  userRevision: string;
  state: "pending" | "processing" | "done" | "attention" | "superseded";
  attempts: number;
  nextAttemptAt?: string;
  dispatches: Dispatch[];
  decision?: OrchestrationDecision;
  selectionLogId?: string;
  workflow?: {
    candidate: WorkflowCandidate;
    planVersion: number;
    artifactRevision?: string;
    applied?: boolean;
  };
  error?: ReturnType<typeof safeError>;
  retiredBudgetRecovery?: { at: string; error: ReturnType<typeof safeError> };
  retiredByRestart?: string;
  notified?: boolean;
  notificationState?: "sending" | "sent" | "retryable" | "uncertain";
  notificationAttempts?: number;
  notificationNextAttemptAt?: string;
  notificationCause?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskOrchestratorOptions {
  config?: AppConfig;
  projects?: ProjectCatalog;
  fetch?: typeof fetch;
  store: Store;
  engine: ConversationEngine;
  tasks(): TaskService;
  tools(actor: ActorContext): RuntimeTool[];
  signal: AbortSignal;
  logger: Logger;
  onReply?(task: Task, text: string, eventId: string): Promise<void>;
  /** Read-only proof that the exact chosen final envelope was already delivered. */
  replyConfirmed?(task: Task, eventId: string): Promise<boolean>;
  /** Read-only proof that re-entering this exact notification callback cannot duplicate delivery. */
  replyRetryable?(task: Task, eventId: string): Promise<boolean>;
  /** Injection for deterministic recovery tests; production uses wall clock. */
  clock?: () => number;
  retryDelayMs?: number;
}
