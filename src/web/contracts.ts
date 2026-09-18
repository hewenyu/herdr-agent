import type { Catalog, Participant, Session, StoredMessage, Task } from "../core/types.js";

export interface WebBackend {
  history(ownerId?: string): WebState;
  dispatch?(action: string, input: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

export type WebActionResult = Record<string, unknown>;

/** All fields may be absent while setup or recovery is still in progress. */
export interface WebState {
  activeOwnerId?: string;
  identities?: Array<{ id: string; sessionCount: number }>;
  catalog?: Catalog;
  projects?: Catalog["projects"];
  sessions?: Session[];
  activeSessionId?: string;
  messages?: StoredMessage[];
  participantNames?: Record<string, string>;
  records?: Array<{
    id: string;
    sessionId: string;
    kind: string;
    createdAt?: string;
    state?: string;
    data: unknown;
  }>;
  tasks?: Task[];
  participants?: Participant[];
  authorization?: { status: string; message?: string; url?: string };
  runtime?: { status: string; message?: string };
  model?: {
    provider?: string;
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    keyConfigured?: boolean;
  };
  config?: {
    ai?: {
      api?: string;
      baseUrl?: string;
      model?: string;
      apiKeyConfigured?: boolean;
      apiKeyMasked?: string;
    };
  };
}

export type WebAssets = Record<"index.html" | "styles.css" | "app.js", string | Uint8Array>;
