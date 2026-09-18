import { safeError } from "../core/errors.js";
import type { Store } from "../storage/store.js";

type PollKind = "task" | "group" | "final_description";
interface PollAttempt {
  at: number;
  error?: string;
}

/** Attempt times survive restart and failed reads; forced events/actions still run immediately. */
export class RemotePolls {
  constructor(
    private readonly store: Store,
    private readonly interval: () => number,
  ) {}

  async run(
    taskId: string,
    kind: PollKind,
    force: boolean,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const id = `${taskId}:${kind}`;
    const previous = this.store.get<PollAttempt>("remote_poll", id);
    const at = Date.now();
    // A backwards wall-clock adjustment must not postpone recovery indefinitely.
    if (!force && previous && at >= previous.at && at - previous.at < this.interval()) return false;
    this.store.set<PollAttempt>("remote_poll", id, { ...previous, at });
    try {
      await operation();
      this.store.set<PollAttempt>("remote_poll", id, { at });
      return true;
    } catch (error) {
      this.store.set<PollAttempt>("remote_poll", id, { at, error: safeError(error).message });
      throw error;
    }
  }

  error(taskId: string): string | undefined {
    return (["task", "group"] as const)
      .map((kind) => this.store.get<PollAttempt>("remote_poll", `${taskId}:${kind}`))
      .filter((entry): entry is PollAttempt => !!entry?.error)
      .sort((left, right) => right.at - left.at)[0]?.error;
  }
}
