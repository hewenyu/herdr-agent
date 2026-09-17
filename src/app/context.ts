import type { AppConfig } from "../config/types.js";
import type { HerdrPort, Logger, PlatformPort } from "../core/ports.js";
import type { ProjectCatalog } from "../projects/catalog.js";
import type { SessionService } from "../runtime/index.js";
import type { Store } from "../storage/store.js";
import type { TaskService } from "../tasks/service.js";
import type { Approvals } from "./approvals.js";
import type { Outbox } from "./outbox.js";

export interface ApplicationContext {
  config: AppConfig;
  store: Store;
  herdr: HerdrPort;
  platform?: PlatformPort;
  projects: ProjectCatalog;
  sessions: SessionService;
  tasks: TaskService;
  approvals: Approvals;
  outbox: Outbox;
  logger: Logger;
  authorization: {
    status: string;
    message: string;
    url?: string;
    expiresAt?: string;
    missingScopes?: string[];
  };
  runtime: { status: string; message: string };
  signal: AbortSignal;
  changed(): void;
}
