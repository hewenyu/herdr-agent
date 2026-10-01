/**
 * Diagnostic projection of one turn's tool-effect counters.
 *
 * The canonical tool evidence is an object that also carries business facts
 * (task IDs, participant names, group/remote flags). The logger deliberately
 * accepts primitives only and drops every nested value, so handing it the
 * evidence object as `toolEvidence` silently loses all of it. These helpers are
 * the ONE approved seam: they flatten the counters the engine already owns into
 * allow-listed primitive fields, and they never read the canonical tool result.
 */
export interface ToolEvidenceCounters {
  successful: number;
  successfulWrites: number;
  unknown: number;
  notExecuted: number;
}

export function createToolEvidenceCounters(): ToolEvidenceCounters {
  return { successful: 0, successfulWrites: 0, unknown: 0, notExecuted: 0 };
}

/**
 * Flat, numeric, allow-listed fields safe for diagnostics. Keys avoid the
 * logger's secret vocabulary so the values survive, and every value is a plain
 * number: no nested object, ID or body can ride along from untrusted evidence.
 * The caller decides where they are logged; they are data, never instructions.
 */
export function toolEvidenceLogFields(counters: ToolEvidenceCounters): Record<string, number> {
  return {
    successfulToolCalls: counters.successful,
    successfulWriteCalls: counters.successfulWrites,
    unknownToolResults: counters.unknown,
    notExecutedToolResults: counters.notExecuted,
  };
}

/**
 * Turn-level diagnostic payload: the flat counters above plus the legacy nested
 * `toolEvidence` shape some raw Logger implementations still read. A
 * primitive-only logger keeps the flat numbers and drops the nested object, so
 * diagnostics never depend on it.
 */
export function turnToolEvidenceLogFields(counters: ToolEvidenceCounters): Record<string, unknown> {
  return {
    ...toolEvidenceLogFields(counters),
    toolEvidence: {
      successful: counters.successful,
      successfulWrites: counters.successfulWrites,
      unknown: counters.unknown,
      notExecuted: counters.notExecuted,
    },
  };
}
