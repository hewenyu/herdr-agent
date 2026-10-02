import type { safeError } from "./errors.js";
import type { ActorContext, CardAction, IncomingMessage } from "./types.js";

export interface InboxRecord {
  id: string;
  type: "message" | "action" | "task" | "group";
  payload: IncomingMessage | CardAction | { id: string };
  actor?: ActorContext;
  generation?: number;
  lane: string;
  state: "queued" | "processing" | "done" | "uncertain" | "failed";
  error?: ReturnType<typeof safeError>;
  createdAt: string;
  sequence: number;
  attempts?: number;
  nextAttemptAt?: number;
  failureNotice?: "pending" | "attempted" | "delivered";
  failureNoticeAttempts?: number;
  failureNoticeNextAttemptAt?: number;
}
