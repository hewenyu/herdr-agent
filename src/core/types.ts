export type AgentKind = "codex" | "claude";
export type TaskKind = "discussion" | "development" | "review" | "test";
export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "review"
  | "attention"
  | "paused"
  | "completed"
  | "destroying"
  | "destroyed";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "gone";
export type DirectoryMode = "shared" | "worktree";

export interface Project {
  name: string;
  directories: string[];
  agent: AgentKind;
}

export interface Catalog {
  projects: Project[];
  defaultProject: string;
  bypass: boolean;
}

export interface ExecutionRef {
  workspaceId: string;
  paneId: string;
  kind: AgentKind;
  cwd: string;
  sessionId?: string;
}

export interface AgentSnapshot {
  paneId: string;
  workspaceId: string;
  kind?: AgentKind;
  status: AgentStatus;
  cwd: string;
  name?: string;
  sessionId?: string;
  terminalId?: string;
  /** Protocol uint64 values must remain exact, including above 2^53. */
  stateSeq: string;
  revision?: string;
  interactiveReady: boolean;
  launchPending: boolean;
}

export interface Delivery {
  status: "delivered" | "queued" | "unconfirmed" | "not_executed";
  acked: boolean;
  verified: boolean;
  attempts: number;
  cancelledDialog?: boolean;
  mayHaveAnsweredDialog?: boolean;
  detail?: string;
}

export interface ScreenOption {
  key: string;
  label: string;
}

export interface AgentScreen {
  agent: AgentSnapshot;
  text: string;
  question: string;
  options: ScreenOption[];
}

export interface TranscriptEntry {
  id: string;
  role: "assistant" | "user" | "tool";
  text: string;
  final: boolean;
  timestamp?: string;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  cursor: string;
  path?: string;
}

export interface Participant {
  id: string;
  taskId: string;
  name: string;
  kind: AgentKind;
  role: string;
  status: AgentStatus | "pending" | "removed";
  execution?: ExecutionRef;
  started: boolean;
  initialSent: boolean;
  initialReceipt: string;
  cursor?: string;
  lastOutput?: string;
  lastStateSeq?: string;
  lastNotifiedState?: string;
  /** A native /clear or compaction does not replace herdr's persistent pane identity. */
  sessionNote?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionPolicy {
  mode: "manual" | "round_robin";
  maxRounds: number;
  maxMinutes: number;
  rounds: number;
  nextParticipant: number;
  activeParticipant?: string;
  startedAt?: string;
  paused: boolean;
}

export interface Task {
  id: string;
  ownerId: string;
  sessionId: string;
  entryChatId: string;
  project?: string;
  kind: TaskKind;
  title: string;
  requirements: string;
  directories: string[];
  directoryMode: DirectoryMode;
  bypass: boolean;
  status: TaskStatus;
  participantIds: string[];
  remoteTaskId?: string;
  remoteTaskUrl?: string;
  chatId?: string;
  groupDeleted: boolean;
  keepGroup: boolean;
  groupRetentionSource?: "explicit" | "default" | "legacy";
  createGroup: boolean;
  createRemoteTask: boolean;
  worktreeReady: boolean;
  parentTaskId?: string;
  parentContext?: {
    taskId: string;
    title: string;
    requirements: string;
    result: string;
    participants: Array<{ name: string; kind: AgentKind; lastOutput: string }>;
  };
  discussion: DiscussionPolicy;
  result: string;
  error?: string;
  syncError?: string;
  pending?: string;
  completionRequest?: "complete" | "reopen";
  closeRequested: boolean;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  remoteCheckedAt?: string;
}

export interface IncomingMessage {
  source: "feishu" | "web";
  eventId: string;
  messageId: string;
  ownerId: string;
  chatId: string;
  chatType: "private" | "group";
  text: string;
  mentionedBot: boolean;
  replyToMessageId?: string;
  unsupportedType?: string;
}

export interface CardAction {
  eventId: string;
  ownerId: string;
  chatId: string;
  messageId: string;
  value: Record<string, unknown>;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  taskId?: string;
  participantId?: string;
  role: "user" | "assistant" | "participant" | "system";
  source: string;
  text: string;
  createdAt: string;
  delivery: "prepared" | "sending" | "delivered" | "uncertain" | "retryable";
  deliveryIds: string[];
  replyToMessageId?: string;
  generation: number;
}

export interface Session {
  id: string;
  ownerId: string;
  name: string;
  taskId?: string;
  generation: number;
  archived: boolean;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateInput {
  kind: TaskKind;
  title: string;
  requirements: string;
  project?: string;
  newProject?: boolean;
  participants: Array<{ kind: AgentKind; name?: string; role?: string }>;
  directoryMode?: DirectoryMode;
  keepGroup?: boolean;
  createGroup?: boolean;
  createRemoteTask?: boolean;
  parentTaskId?: string;
  discussion?: Partial<Pick<DiscussionPolicy, "mode" | "maxRounds" | "maxMinutes">>;
}

export interface ActorContext {
  source?: "web" | "feishu" | "system";
  chatType?: "private" | "group";
  ownerId: string;
  chatId: string;
  sessionId: string;
  taskId?: string;
  messageId: string;
}
