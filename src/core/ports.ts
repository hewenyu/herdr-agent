import type {
  AgentKind,
  AgentScreen,
  AgentSnapshot,
  CardAction,
  Delivery,
  ExecutionRef,
  IncomingMessage,
  TranscriptEntry,
  TranscriptPage,
} from "./types.js";

export interface HerdrPort {
  ping(signal?: AbortSignal): Promise<{ version: string; protocol: number }>;
  list(signal?: AbortSignal): Promise<AgentSnapshot[]>;
  get(paneId: string, signal?: AbortSignal): Promise<AgentSnapshot>;
  createWorkspace(
    cwd: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<{
    workspaceId: string;
    paneId: string;
    cwd: string;
  }>;
  startAgent(
    paneId: string,
    kind: AgentKind,
    name: string,
    options: { directories: string[]; bypass: boolean; signal?: AbortSignal },
  ): Promise<AgentSnapshot>;
  send(
    ref: ExecutionRef,
    text: string,
    options?: {
      receipt?: string;
      signal?: AbortSignal;
    },
  ): Promise<Delivery>;
  interrupt(ref: ExecutionRef, signal?: AbortSignal): Promise<void>;
  screen(ref: ExecutionRef, signal?: AbortSignal): Promise<AgentScreen>;
  answer(
    ref: ExecutionRef,
    key: string,
    guard: {
      stateSeq: string;
      sessionId?: string;
      expiresAt: string;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  /** Restricted startup directory trust; no caller-selected approval keys. */
  trustDirectory?(
    ref: ExecutionRef,
    expectedDirectory: string,
    guard: { stateSeq: string; sessionId?: string; expiresAt: string; signal?: AbortSignal },
  ): Promise<void>;
  close(ref: ExecutionRef, signal?: AbortSignal): Promise<void>;
  transcript(ref: ExecutionRef, cursor?: string): Promise<TranscriptPage>;
  sampleLastReply(ref: ExecutionRef): Promise<TranscriptEntry | undefined>;
  /** Exact native user input, with receipt and session/cwd identity verified read-only. */
  initialInput?(ref: ExecutionRef, receipt: string): Promise<string | undefined>;
}

export interface RemoteTask {
  id: string;
  url: string;
  description: string;
  completedAt: string;
}

export interface PlatformHandlers {
  message(message: IncomingMessage): Promise<void>;
  action(action: CardAction): Promise<void>;
  taskChanged(id: string): Promise<void>;
  groupChanged?(chatId: string): Promise<void>;
}

export interface PlatformPort {
  start(handlers: PlatformHandlers, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string, key: string, replyTo?: string): Promise<string>;
  sendCard(chatId: string, card: Record<string, unknown>, key: string): Promise<string>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  createTask(input: {
    title: string;
    description: string;
    ownerId: string;
    key: string;
  }): Promise<RemoteTask>;
  getTask(id: string): Promise<RemoteTask>;
  updateTask(id: string, description: string, completedAt?: string): Promise<void>;
  createGroup(name: string, ownerId: string, key: string): Promise<string>;
  deleteGroup(chatId: string): Promise<void>;
  getGroupStatus?(chatId: string): Promise<"normal" | "dissolved">;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
