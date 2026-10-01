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

export interface InputProgress {
  phase: "write_started" | "acknowledged" | "readback_completed";
  at: string;
  verified?: boolean;
}

export interface NativeSendOptions {
  receipt?: string;
  signal?: AbortSignal;
  /** Synchronous admission guard, checked again immediately before socket.write. */
  assertCurrent?: () => void;
  /** Metadata only: never include prompt text or receipt contents. */
  onProgress?: (progress: InputProgress) => void;
}

export interface HerdrPort {
  ping(signal?: AbortSignal): Promise<{ version: string; protocol: number }>;
  list(signal?: AbortSignal): Promise<AgentSnapshot[]>;
  get(paneId: string, signal?: AbortSignal): Promise<AgentSnapshot>;
  /** Read-only pane presence: false only for pane_not_found; all other failures throw. */
  paneExists(paneId: string, signal?: AbortSignal): Promise<boolean>;
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
    options: {
      directories: string[];
      bypass: boolean;
      signal?: AbortSignal;
      beforeWrite?: () => void;
    },
  ): Promise<AgentSnapshot>;
  send(ref: ExecutionRef, text: string, options?: NativeSendOptions): Promise<Delivery>;
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
      screenFingerprint?: string;
      terminalId?: string;
      cwd?: string;
      literalKey?: boolean;
      beforeWrite?: () => Promise<void>;
      assertCurrent?: () => void;
    },
  ): Promise<void>;
  /** Restricted startup directory trust; no caller-selected approval keys. */
  trustDirectory?(
    ref: ExecutionRef,
    expectedDirectory: string,
    guard: {
      stateSeq: string;
      sessionId?: string;
      expiresAt: string;
      signal?: AbortSignal;
      worktreeRoot?: string;
      /** Observed native terminal identity; a change vetoes the write. */
      terminalId?: string;
      /** Last-moment authorization/control check, run after the final native read. */
      beforeWrite?: () => Promise<void>;
      /** Synchronous admission check immediately before the keys are written. */
      assertCurrent?: () => void;
    },
  ): Promise<void>;
  close(ref: ExecutionRef, signal?: AbortSignal): Promise<void>;
  transcript(ref: ExecutionRef, cursor?: string): Promise<TranscriptPage>;
  /** Scoped recent conversation with independent pagination; never changes observation cursors. */
  conversation?(
    ref: ExecutionRef,
    receipt: string,
    cursor?: string,
  ): Promise<{
    entries: TranscriptEntry[];
    cursor?: string;
    truncated: boolean;
  }>;
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
  start(
    handlers: PlatformHandlers,
    signal: AbortSignal,
    onFailure?: (error: Error) => void,
  ): Promise<void>;
  /** Subscribe the current application to changes of tasks it is assigned to. */
  subscribeTasks(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string, key: string, replyTo?: string): Promise<string>;
  sendCard(chatId: string, card: Record<string, unknown>, key: string): Promise<string>;
  /** Upload frozen report content only; callers persist upload and message receipts separately. */
  uploadFile?(name: string, content: string): Promise<string>;
  sendFile?(chatId: string, fileKey: string, key: string): Promise<string>;
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
