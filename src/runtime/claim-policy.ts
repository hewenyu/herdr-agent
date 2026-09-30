import { assertionClauses, hasUnverifiedToolClaim, requiresWriteEvidence } from "./claims.js";
import { type ProvisionEvidence, unsupportedProvisionClaim } from "./provision-evidence.js";

/** Outcome counters and provisioning snapshots belong to this turn, not history. */
export interface ClaimEvidence {
  successful: number;
  successfulWrites?: number;
  unknown: number;
  notExecuted: number;
  unresolvedNotExecuted?: number;
  provisioning?: ProvisionEvidence;
}

/** Shared boundary for both the pi loop and the persisted session reply. */
export function evaluateClaimPolicy(
  text: string,
  evidence: ClaimEvidence,
  requireEvidence = false,
): { rejected: boolean; hasCredibleEvidence: boolean; needsWrite: boolean } {
  const provisioning = evidence.provisioning;
  const needsWrite = assertionClauses(text).some(
    (clause) =>
      requiresWriteEvidence(clause) &&
      (!provisioning || !supportedResourceState(clause, provisioning)),
  );
  const hasCredibleEvidence =
    evidence.unknown === 0 &&
    (evidence.unresolvedNotExecuted ?? evidence.notExecuted) === 0 &&
    (needsWrite ? (evidence.successfulWrites ?? 0) > 0 : evidence.successful > 0);
  const emptyProvisioning: ProvisionEvidence = { created: [], tasks: [] };
  const provisionClaim = unsupportedProvisionClaim(text, emptyProvisioning);
  const unsupported = unsupportedProvisionClaim(text, provisioning ?? emptyProvisioning);
  return {
    rejected:
      ((hasUnverifiedToolClaim(text) || provisionClaim || requireEvidence) &&
        !hasCredibleEvidence) ||
      unsupported,
    hasCredibleEvidence,
    needsWrite,
  };
}

function supportedResourceState(text: string, evidence: ProvisionEvidence): boolean {
  // A resource snapshot proves existence/delivery, not who performed a new
  // operation. Other actions must not borrow a supported provisioning clause.
  if (
    /(?:我|我们|本轮|本次|这次|刚刚|刚才|(?:为|帮)(?:你|您|用户)|新建|新的|另一个|安排|启动|将|马上|接下来|\b(?:I|we|this\s+turn|just|new|another|schedule|start|will)\b)/iu.test(
      text,
    ) ||
    /(?:项目|目录|会话|\b(?:project|directory|workspace|session)\b)/iu.test(text)
  )
    return false;
  // An empty snapshot must fail first: a statement that contains no recognized
  // resource claim is not evidence-backed merely because it is not rejected.
  return (
    unsupportedProvisionClaim(text, { created: [], tasks: [] }) &&
    !unsupportedProvisionClaim(text, evidence)
  );
}
