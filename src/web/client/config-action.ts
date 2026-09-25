import type { Action } from "./api.js";
import { modalFeedback } from "./dom.js";

export function configurationAction(
  dispatch: Action,
  refresh: () => Promise<void>,
  feedback: (message: string, error?: boolean) => void,
): Action {
  return async (name, input) => {
    const localFeedback = modalFeedback();
    localFeedback?.();
    try {
      const result = await dispatch(name, input);
      await refresh();
      localFeedback?.();
      feedback(name === "config.ai" ? "模型配置已保存，重启服务后生效。" : "配置已保存。");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "配置未完成，请核对输入。";
      if (localFeedback) localFeedback(message);
      else feedback(message, true);
      return undefined;
    }
  };
}
