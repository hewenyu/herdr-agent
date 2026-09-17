import type {
  AgentScreen,
  Catalog,
  Participant,
  Session,
  StoredMessage,
  Task,
} from "../core/types.js";

export interface WebBackend {
  snapshot(): unknown;
  dispatch(action: string, input: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

/** All fields may be absent while setup or recovery is still in progress. */
export interface WebState {
  catalog?: Catalog;
  projects?: Catalog["projects"];
  sessions?: Session[];
  activeSessionId?: string;
  messages?: StoredMessage[];
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

export interface WebActionResult {
  id?: string;
  text?: string;
  role?: StoredMessage["role"];
  createdAt?: string;
  delivery?: StoredMessage["delivery"];
  deliveryIds?: string[];
  generation?: number;
  source?: string;
  screen?: AgentScreen;
  approval?: { nonce: string; options?: Array<{ key: string; label: string }> };
  detail?: string;
  message?: string;
  status?: string;
  sessionId?: string;
}

/**
 * Action contract consumed by the application facade:
 * project.save {name,directories,agent}; project.delete/default {name}; catalog.bypass {bypass}
 * session.create {name}; session.select/archive/clear {id}; session.rename {id,name}
 * chat.send {sessionId,text}; task.create TaskCreateInput + {sessionId}
 * task.action {id,action}; participant.send {taskId,participantId,text}
 * participant.interrupt/screen {taskId,participantId}; interrupt with participantId="all" affects all.
 * participant.answer {taskId,nonce,key}; session.restore {id}; chat.ack {messageId,sessionId}
 * participant.add {taskId,kind,name?,role?}; participant.remove {taskId,participantId}
 * config.ai {provider,enabled,baseUrl,model,apiKey?}; saved key is never returned to the browser.
 * Destructive authorization and actor ownership remain the facade's responsibility.
 */
export type WebAssets = Record<"index.html" | "styles.css" | "app.js", string | Uint8Array>;
