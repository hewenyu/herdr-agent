import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Logger } from "../core/ports.js";
import type { ActorContext, StoredMessage } from "../core/types.js";
import type { ProvisionEvidence } from "./provision-evidence.js";

/** Only application business tools are injected; this runtime has no coding or shell tools. */
export interface RuntimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  execute(
    args: Record<string, unknown>,
    actor: ActorContext,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<unknown>;
}

export interface EngineInput {
  actor: ActorContext;
  systemPrompt: string;
  messages: AgentMessage[];
  prompt: string;
  tools: RuntimeTool[];
  sessionId: string;
  signal?: AbortSignal;
  onCheckpoint?: (messages: AgentMessage[]) => Promise<void> | void;
  /** Internal summaries do not represent user-visible business claims. */
  enforceClaims?: boolean;
  /** Internal authorized operation, never derived directly from user text or model output. */
  requireToolCall?: boolean;
}

export interface EngineResult {
  text: string;
  messages: AgentMessage[];
  /** Number of tool calls emitted during this run, including read-only calls. */
  toolCalls?: number;
  /** Number of write tools that actually started during this run. */
  writeCalls?: number;
  /** Tool-result provenance used to reject success claims after failed or unknown effects. */
  toolEvidence?: {
    successful: number;
    successfulWrites?: number;
    unknown: number;
    notExecuted: number;
    /** Earlier rejected attempts remain in counters; a successful retry resolves that tool. */
    unresolvedNotExecuted?: number;
    provisioning?: ProvisionEvidence;
  };
}
export interface SummaryInput {
  messages: AgentMessage[];
  previousSummary: string;
  signal?: AbortSignal;
}
export interface ConversationEngine {
  readonly contextTokens: number;
  run(input: EngineInput): Promise<EngineResult>;
  summarize(input: SummaryInput): Promise<string>;
}
export interface EngineOptions {
  streamFn?: StreamFn;
  fetch?: typeof fetch;
  logger?: Logger;
}
export interface ReplyOptions {
  signal?: AbortSignal;
  readOnly?: boolean;
  systemPrompt?: string;
}
export interface DeliveryOutcome {
  complete: boolean;
  ids: string[];
  retryable?: boolean;
}
export interface ExternalMessage {
  id: string;
  text: string;
  participantId?: string;
  source?: string;
  deliveredAt?: string;
  /** Web-only outputs become visible context only after the UI acknowledges rendering. */
  pendingDelivery?: boolean;
}
export interface TurnReceipt {
  generation: number;
  status: "running" | "finished" | "failed";
  replyId: string;
}
export type MessageRecord = StoredMessage & { sequence: number };
