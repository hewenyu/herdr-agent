import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";
import type { ActorContext, Session } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { estimateTokens } from "./engine.js";
import { type MemoryProvider, memoryEntry } from "./memory.js";
import { contextMessages } from "./session-records.js";
import type { ConversationEngine, MessageRecord, RuntimeTool } from "./types.js";

export interface SummaryCursor {
  generation: number;
  sequence: number;
}

/** Callbacks the service keeps authoritative while history preparation runs. */
export interface HistoryContext {
  store: Store;
  engine: ConversationEngine;
  memory: MemoryProvider;
  records(sessionId: string): MessageRecord[];
  /** Session generation may not change mid-compaction. */
  currentGeneration(actor: ActorContext, session: Session): number;
}

/**
 * Build the bounded model request history: recall durable memory, keep the
 * current generation, and compact only by generating a real summary with a
 * durable cursor, so an oversized request can never be retried unchanged.
 */
export async function prepareHistory(
  context: HistoryContext,
  actor: ActorContext,
  session: Session,
  text: string,
  prompt: string,
  tools: RuntimeTool[],
  signal: AbortSignal,
): Promise<AgentMessage[]> {
  const { store, engine } = context;
  const contextMessagesFor = (records: MessageRecord[]) => contextMessages(store, records);
  const unchanged = () => context.currentGeneration(actor, session) === session.generation;
  const recalled = await context.memory.recall(actor, signal);
  const records = context
    .records(session.id)
    .filter((message) => message.generation === session.generation);
  if (!records.length && session.generation === 0 && !session.summary)
    session.summary = recalled.summary;
  const cursor = store.get<SummaryCursor>("summary_cursor", session.id);
  let relevant = records.filter(
    (message) =>
      !cursor || cursor.generation !== session.generation || message.sequence > cursor.sequence,
  );
  let messages = contextMessagesFor(relevant);
  const fixed = estimateTokens({
    prompt,
    text,
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  });
  if (fixed > engine.contextTokens * 0.75)
    throw new OperationError(
      "context_budget",
      "当前输入或工具定义超过模型上下文容量；请缩短输入。",
    );
  if (
    estimateTokens({ messages, summary: session.summary }) + fixed <=
    engine.contextTokens * 0.85
  ) {
    if (recalled.summary !== session.summary)
      await context.memory.store(actor, memoryEntry(session.summary), signal);
    if (signal.aborted || !unchanged()) throw new OperationError("cancelled", "会话已重置。");
    store.set("sessions", session.id, session);
    return messages;
  }
  const keep = Math.min(8, Math.max(1, relevant.length));
  let cut = Math.max(0, relevant.length - keep);
  while (
    cut < relevant.length &&
    estimateTokens(contextMessagesFor(relevant.slice(cut))) + fixed > engine.contextTokens * 0.5
  )
    cut++;
  if (!cut) throw new OperationError("context_budget", "上下文无法安全压缩；原始历史保留。");
  const old = relevant.slice(0, cut);
  let summary = session.summary;
  let chunk: AgentMessage[] = [];
  for (const message of contextMessagesFor(old)) {
    if (
      estimateTokens({ messages: [...chunk, message], previousSummary: summary }) >
        engine.contextTokens * 0.65 &&
      chunk.length
    ) {
      summary = await engine.summarize({ messages: chunk, previousSummary: summary, signal });
      chunk = [];
    }
    if (estimateTokens(message) > engine.contextTokens * 0.65)
      throw new OperationError("context_budget", "单条历史过长，原文保留，请调整模型上下文容量。");
    chunk.push(message);
  }
  if (chunk.length)
    summary = await engine.summarize({ messages: chunk, previousSummary: summary, signal });
  if (signal.aborted || !unchanged()) throw new OperationError("cancelled", "会话已重置。");
  await context.memory.store(actor, memoryEntry(summary), signal);
  if (signal.aborted || !unchanged()) throw new OperationError("cancelled", "会话已重置。");
  session.summary = summary;
  store.transaction(() => {
    store.set("sessions", session.id, session);
    store.set<SummaryCursor>("summary_cursor", session.id, {
      generation: session.generation,
      sequence: old.at(-1)?.sequence ?? 0,
    });
  });
  relevant = relevant.slice(cut);
  messages = contextMessagesFor(relevant);
  return messages;
}
