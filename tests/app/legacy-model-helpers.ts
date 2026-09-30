import type { ActorContext, Task, TaskCreateInput } from "../../src/core/types.js";
import type { Store } from "../../src/storage/store.js";
import type { TaskService } from "../../src/tasks/service.js";
import { persistLegacyMode } from "../tasks/helpers.js";

/** Create normally, then restore the persisted mode to model to simulate an upgraded task. */
export async function createLegacyModelTask(
  fixture: { app: { tasks: TaskService }; store: Store },
  actor: ActorContext,
  input: TaskCreateInput,
): Promise<Task> {
  const task = await fixture.app.tasks.create(actor, input);
  return persistLegacyModelTask(fixture.store, task);
}

/** Restore a normally created task record, including task.create dispatch results. */
export function persistLegacyModelTask(store: Store, task: Task): Task {
  return persistLegacyMode(store, { ...task }, { orchestration: { mode: "model" } });
}
