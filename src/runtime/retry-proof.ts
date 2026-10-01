/**
 * Durable proof that retrying one failed model request is justified.
 *
 * A guarded `context_budget` retry exists for exactly one situation: the
 * durable context the model just rejected has since been provably reduced, so
 * the retried request is not the unchanged request that failed. Counting
 * bounded references, or diffing against the turn's initial engine history,
 * cannot prove that. A request that already carries references contains them
 * too (so reference growth since an initial, usually empty, history is not new
 * reduction), and prompt insertion, timestamps or dropped error envelopes
 * change bytes without shrinking anything the model was asked to read.
 *
 * The proof is therefore measured on matched tool-result envelopes only:
 *
 *  - save-time proof ({@link checkpointReduction}): the checkpoint input the
 *    engine handed to persistence carried a tool-result envelope larger than
 *    the per-result model budget, and the durable form actually stored is
 *    inside that budget and strictly smaller. The proof is bound by digest to
 *    the exact stored transcript, so a later, unreduced checkpoint
 *    invalidates it ({@link reductionMatches}).
 *  - exact restored receipts: counted by `recoverMessagesDetailed`, whose
 *    restored counts only ever come from this turn's exact operation ids.
 *
 * None of them can be produced by prompt text, metadata, dropped assistant
 * errors or a comparison against a caller-supplied history, and no missing
 * result is ever turned into a success here.
 *
 * A diff against "the failed request" is deliberately NOT part of the
 * decision. No durable caller can prove it holds the exact provider request:
 * `EngineInput.messages` is the turn's INITIAL input array, which an engine may
 * extend or replace internally before the request that failed, and a legacy
 * checkpoint may already have been handed to the engine in its bounded
 * recovery view while its raw bytes stay on disk. {@link recoveredReduction}
 * remains the primitive for an exact latest-request snapshot, but it is not
 * wired into {@link retryAfterReduction}, because comparing any stale array
 * against the recovered form would read an OLD reduction as a NEW one.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MODEL_RESULT_MAX_BYTES } from "./model-context.js";

/** Durable checkpoint record of one turn, as `SessionService` stores it. */
export interface StoredCheckpoint {
  messages: AgentMessage[];
  generation: number;
  sessionId?: string;
  /** Save-time reduction proof, valid only for the digest it was stored with. */
  reduction?: CheckpointReduction;
  updatedAt?: string;
}

/** Durable proof that one checkpoint input was really reduced before storage. */
export interface CheckpointReduction {
  /** Tool-result envelopes the durable bound actually shrank. */
  projected: number;
  /** Serialized tool-result envelopes of the checkpoint input, in bytes. */
  inputBytes: number;
  /** Serialized tool-result envelopes of the stored checkpoint, in bytes. */
  storedBytes: number;
  /** Identity of the exact stored transcript this proof belongs to. */
  storedDigest: string;
}

/** The evidence a `context_budget` retry must be justified by. */
export interface RetryEvidence {
  /**
   * Latest durable checkpoint presented to recovery: the identity anchor for
   * its save-time proof, NOT a claim that these bytes equal the failed provider
   * request. It may already be a bounded projection, or a legacy raw record.
   * A working history an engine mutated internally is intentionally not
   * accepted here; see the module comment.
   */
  checkpoint: AgentMessage[];
  /** Recovery result of that checkpoint. */
  recovered: AgentMessage[];
  /** Save-time proof recorded with this checkpoint, if it has one. */
  reduction?: CheckpointReduction;
  /** Exact completed receipts restored from this turn's operation journal. */
  restoredCompleted: number;
  /** Largest model transcript that may be replayed for this context size. */
  limitBytes: number;
}

/**
 * The recovered messages that may be retried, or `undefined` when no new
 * durable reduction of the failed request can be proven (the caller keeps the
 * typed failure). A recovered transcript that still cannot fit one request is
 * never returned.
 *
 * Both surviving proofs are anchored to identity, never to a diff against a
 * caller-supplied history: the save-time proof is bound by digest to the exact
 * stored transcript, so any later save invalidates it, and a restored receipt
 * is matched by this turn's exact operation id. A retry therefore requires a
 * durable write that really reduced THIS checkpoint, or a missing model result
 * this turn's own journal can repair; neither can be produced by the engine's
 * initial input array growing, nor by an earlier reduction still lying around
 * in a mutable array the engine happens to hold.
 */
export function retryAfterReduction(evidence: RetryEvidence): AgentMessage[] | undefined {
  const recovered = evidence.recovered;
  if (!recovered.length) return undefined;
  if (serializedBytes(recovered) > evidence.limitBytes) return undefined;
  if (reductionMatches(evidence.reduction, evidence.checkpoint)) return recovered;
  // A restored exact receipt is a real repair of THIS request: the failed
  // request was missing the model result of a call that had already completed,
  // and the retried request differs by that call's canonical value. A pending
  // or unknown effect never reaches here (`recoverMessagesDetailed` refuses).
  return evidence.restoredCompleted > 0 ? recovered : undefined;
}

/**
 * Proof for the checkpoint just stored, or `undefined` when nothing shrank.
 * An input whose envelopes already fit the budget is never a reduction, so a
 * previously saved reference cannot authorize a retry.
 */
export function checkpointReduction(
  input: AgentMessage[],
  stored: AgentMessage[],
  maxBytes = MODEL_RESULT_MAX_BYTES,
): CheckpointReduction | undefined {
  let projected = 0;
  let inputBytes = 0;
  let storedBytes = 0;
  for (let index = 0; index < input.length; index++) {
    const before = input[index];
    if (before?.role !== "toolResult") continue;
    const beforeBytes = envelopeBytes(before);
    inputBytes += beforeBytes;
    // The durable bound maps one message to one message. A missing counterpart
    // means this input was not stored as such an envelope, so nothing is proven.
    const after = stored[index];
    if (after?.role !== "toolResult") continue;
    const afterBytes = envelopeBytes(after);
    storedBytes += afterBytes;
    if (beforeBytes > maxBytes && afterBytes <= maxBytes && afterBytes < beforeBytes) projected++;
  }
  if (projected < 1) return undefined;
  const digest = durableDigest(stored);
  if (digest === undefined) return undefined;
  return { projected, inputBytes, storedBytes, storedDigest: digest };
}

/**
 * True only while the stored checkpoint is still exactly the transcript the
 * reduction proof was recorded for. A checkpoint that moved on afterwards
 * carries no evidence that the request which failed was reduced, so it must
 * not be retried.
 */
export function reductionMatches(
  reduction: CheckpointReduction | undefined,
  stored: AgentMessage[],
): boolean {
  if (!reduction || reduction.projected < 1) return false;
  const digest = durableDigest(stored);
  return digest !== undefined && digest === reduction.storedDigest;
}

/**
 * Envelope-level reduction between two transcripts: a tool-result envelope of
 * `failed` exceeded the per-result budget and the same call's envelope in
 * `recovered` is inside it and strictly smaller. Messages are matched by call
 * identity only; dropping an errored assistant turn or inserting a prompt is
 * never evidence.
 *
 * `failed` must be the EXACT transcript of the latest failed provider request.
 * No durable caller can prove that: `EngineInput.messages` is the turn's
 * initial input (an engine may grow or replace it internally), and a legacy
 * checkpoint's bytes may already have been superseded by the bounded recovery
 * view the engine actually received. {@link retryAfterReduction} therefore
 * does not use this diff; it is exposed as a primitive for a caller that
 * genuinely holds such a snapshot, and the durable save-time proof is used
 * instead because it is bound to the stored transcript by digest.
 */
export function recoveredReduction(
  failed: AgentMessage[],
  recovered: AgentMessage[],
  maxBytes = MODEL_RESULT_MAX_BYTES,
): boolean {
  const before = new Map<string, { bytes: number; isError: boolean }>();
  for (const message of failed) {
    if (message.role !== "toolResult") continue;
    before.set(message.toolCallId, {
      bytes: envelopeBytes(message),
      isError: message.isError === true,
    });
  }
  for (const message of recovered) {
    if (message.role !== "toolResult") continue;
    const original = before.get(message.toolCallId);
    if (original === undefined || original.bytes <= maxBytes) continue;
    // A durable projection keeps the original outcome flag; an inferred
    // not_executed closure flips it. A flipped envelope is a substituted
    // outcome, not a reduced one, so it proves nothing.
    if ((message.isError === true) !== original.isError) continue;
    const boundedBytes = envelopeBytes(message);
    if (boundedBytes <= maxBytes && boundedBytes < original.bytes) return true;
  }
  return false;
}

/**
 * Identity of a transcript as the durable store keeps it: `Store` serializes
 * with `JSON.stringify` and reads back with `JSON.parse`, so the digest is
 * computed over that same round trip and matches a later `get` exactly.
 */
export function durableDigest(messages: AgentMessage[]): string | undefined {
  const text = durableText(messages);
  return text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
}

/** UTF-8 bytes of one complete serialized message envelope. */
function envelopeBytes(message: AgentMessage): number {
  const text = durableText(message);
  return text === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(text, "utf8");
}

/** UTF-8 bytes of a durable transcript, or `MAX_SAFE_INTEGER` when not serializable. */
function serializedBytes(messages: AgentMessage[]): number {
  const text = durableText(messages);
  return text === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(text, "utf8");
}

/**
 * `Store`'s own round trip; unserializable input proves nothing. A message
 * shaped like the schema is measured as itself, so the budget comparison is
 * against the same bytes the engine hands the provider.
 */
function durableText(value: AgentMessage | AgentMessage[]): string | undefined {
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value)));
  } catch {
    return undefined;
  }
}
