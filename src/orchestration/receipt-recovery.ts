import { createHash } from "node:crypto";
import { join } from "node:path";
import { safeError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import { atomicWrite } from "../storage/atomic.js";
import type { Store } from "../storage/store.js";
import { boardDirectory } from "./board.js";
import { checkedHandoffDirectory, handoffDirectory, readHandoffFile } from "./handoff.js";
import { type ReceiptDiagnostic, ReceiptError } from "./receipt-diagnostics.js";
import type { NodeProgress, WorkflowNode, WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

export const WORKFLOW_RECOVERY = "workflow_recovery_materials";

export interface WorkflowRepair {
  code: string;
  details: ReceiptDiagnostic[];
  fingerprint: string;
  /** Consecutive identical diagnostics in the same input/source/plan revision. */
  repeated: number;
  recoverable: boolean;
  outputId: string;
  operationId: string;
  inputRevision: string;
  /** Original dispatch source; retained for read-only and scope attribution. */
  artifactRevision?: string;
  /** Source observed after this output and validated against the node's write boundary. */
  observedArtifactRevision?: string;
  planVersion: number;
  snapshotId: string;
  /** Present only after receipt identity and safe, immutable notes capture were checked. */
  notes?: { path: string; hash: string };
}

/** Older rejected read-only receipts were bound directly to the dispatch source. */
export const receiptRepairRevision = (repair: WorkflowRepair): string | undefined =>
  repair.observedArtifactRevision ?? repair.artifactRevision;

export interface WorkflowRecoveryMaterial {
  id: string;
  validation: "unverified";
  taskId: string;
  nodeId: string;
  participantId: string;
  outputId: string;
  text: string;
  notes?: string;
  notesHash?: string;
  receiptIdentityMatched: boolean;
  repair: WorkflowRepair;
  createdAt: string;
}

/** Recovery authorship comes from the immutable rejected output, not the latest assignment. */
export function receiptRepairOwner(
  store: Store,
  taskId: string,
  nodeId: string,
  repair: WorkflowRepair,
): string | undefined {
  const material = store.get<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY, repair.snapshotId);
  if (
    material?.validation !== "unverified" ||
    material.taskId !== taskId ||
    material.nodeId !== nodeId ||
    material.outputId !== repair.outputId ||
    material.repair.operationId !== repair.operationId ||
    material.repair.fingerprint !== repair.fingerprint ||
    material.repair.inputRevision !== repair.inputRevision ||
    material.repair.planVersion !== repair.planVersion ||
    receiptRepairRevision(material.repair) !== receiptRepairRevision(repair)
  )
    return undefined;
  return material.participantId;
}

/** Capture untrusted recovery context without granting it accepted-evidence status. */
export async function recordWorkflowRejection(input: {
  store: Store;
  stateDir: string;
  task: Task;
  state: WorkflowState;
  node: WorkflowNode;
  progress: NodeProgress;
  participantId: string;
  output: { id: string; text: string };
  error: unknown;
  /** Set only after the post-output source has passed the original node/scope guards. */
  observedArtifactRevision?: string;
  /** Only a persisted rule-selected receipt-only dispatch can continue the repair streak. */
  continuingReceiptRepair?: boolean;
}): Promise<WorkflowRepair> {
  const { store, stateDir, task, state, node, progress, participantId, output, error } = input;
  const observedArtifactRevision = input.observedArtifactRevision;
  const failure = safeError(error);
  const details =
    error instanceof ReceiptError
      ? error.details
      : [{ field: "$", reason: failure.code, actual: failure.message }];
  // New operation-specific directories do not turn the same missing-path defect into progress.
  const normalized = details.map((detail) =>
    Object.fromEntries(
      Object.entries(detail).map(([key, value]) => [
        key,
        value.replace(/\/handoffs\/[a-f0-9]{32}\//g, "/handoffs/<operation>/"),
      ]),
    ),
  );
  const fingerprint = stableId(failure.code, canonical(normalized));
  const snapshotId = stableId(
    task.id,
    output.id,
    String(state.plan.version),
    progress.inputRevision ?? "",
    observedArtifactRevision ?? progress.artifactRevision ?? "",
    fingerprint,
  );
  const existing = store.get<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY, snapshotId);
  if (existing) return existing.repair;
  const previous = input.continuingReceiptRepair ? progress.repair : undefined;
  const repeating =
    !!previous &&
    receiptRepairOwner(store, task.id, node.id, previous) === participantId &&
    previous?.fingerprint === fingerprint &&
    previous.inputRevision === progress.inputRevision &&
    receiptRepairRevision(previous) === (observedArtifactRevision ?? progress.artifactRevision) &&
    previous.planVersion === state.plan.version;
  const repair: WorkflowRepair = {
    code: failure.code,
    details,
    fingerprint,
    repeated: repeating ? previous.repeated + 1 : 1,
    recoverable: error instanceof ReceiptError && error.recoverable && !!observedArtifactRevision,
    outputId: output.id,
    operationId: progress.operationId ?? "",
    inputRevision: progress.inputRevision ?? "",
    artifactRevision: progress.artifactRevision,
    observedArtifactRevision,
    planVersion: state.plan.version,
    snapshotId,
  };
  if (repair.recoverable)
    try {
      if (observedArtifactRevision !== (await workspaceRevision(task.directories)))
        repair.recoverable = false;
    } catch {
      // A source that became unreadable after validation cannot authorize notes reuse.
      repair.recoverable = false;
    }
  const material: WorkflowRecoveryMaterial = {
    id: snapshotId,
    validation: "unverified",
    taskId: task.id,
    nodeId: node.id,
    participantId,
    outputId: output.id,
    text: output.text.slice(0, 16_000),
    receiptIdentityMatched: false,
    repair,
    createdAt: new Date().toISOString(),
  };
  if (task.promptVersion === 3 && progress.operationId) {
    const directory = handoffDirectory(stateDir, task.id, progress.operationId);
    try {
      const receipt = JSON.parse(await readHandoffFile(stateDir, directory, "result.json"));
      material.receiptIdentityMatched =
        receipt?.nodeId === node.id &&
        receipt?.operationId === progress.operationId &&
        receipt?.inputRevision === progress.inputRevision;
      // A missing natural-language path must not mask a foreign receipt identity.
      if (!material.receiptIdentityMatched) repair.recoverable = false;
    } catch (captureError) {
      if (safeError(captureError).code === "workflow_handoff") repair.recoverable = false;
      // Malformed or unsafe receipts never authorize reuse of notes.
    }
    try {
      const notes = await readHandoffFile(stateDir, directory, "notes.md");
      if (notes.trim()) {
        material.notes = notes;
        material.notesHash = createHash("sha256").update(notes).digest("hex");
        if (material.receiptIdentityMatched && repair.recoverable) {
          const frozen = join(boardDirectory(stateDir, task.id), "recovery", snapshotId);
          await checkedHandoffDirectory(stateDir, frozen, true);
          // A snapshot is never read back as accepted output. Its hash guards future reuse.
          await atomicWrite(join(frozen, "notes.md"), notes);
          repair.notes = { path: join(frozen, "notes.md"), hash: material.notesHash };
        }
      }
    } catch (captureError) {
      if (safeError(captureError).code === "workflow_handoff") repair.recoverable = false;
      // Broken, oversized or symlinked material stays unavailable, never copied from another path.
    }
  }
  store.set(WORKFLOW_RECOVERY, snapshotId, material);
  return repair;
}
