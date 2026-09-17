import { Operations } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import { assertActive } from "./context.js";

/** Shutdown gates new effects; an already submitted effect still records its real outcome. */
export class TaskOperations extends Operations {
  constructor(
    store: Store,
    readonly signal: AbortSignal,
  ) {
    super(store);
  }
  override run<T>(id: string, parameters: unknown, perform: () => Promise<T>): Promise<T> {
    assertActive(this);
    return super.run(id, parameters, () => {
      assertActive(this);
      return perform();
    });
  }
}
