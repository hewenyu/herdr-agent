# Agent lifecycle readiness and startup trust

This record explains the two independent state machines that govern a managed
participant, the readiness model that replaces "started means ready", and the
generation-scoped startup directory-trust rules. It documents the contract the
implementation and tests in this repository enforce; it makes no claim about a
production deployment.

## Two independent state machines

The earlier design conflated two questions. "May we dispatch business work?" and
"is the executor able to receive it?" are not the same question, and coupling
them produced the failure this work repairs: a business pause stopped lifecycle
repair, and a recovered executor was reported ready while it was still blocked on
a startup menu.

**Business scheduling** answers whether new business input and relays may be
written. It is settled by explicit user control and lifecycle ends:

- `pause`, `interrupt`, `participants_remove`, `complete`, `close`, `destroy`,
  `reopen`, and a plain manual `send` all settle it;
- while settled, no automatic business prompt, relay or dispatch may be written;
- an explicit fresh user `send` may address its selected participant, but does not
  lift a genuine task-wide pause or another participant's executor hold.

**Agent lifecycle / readiness** answers whether the managed execution exists and
can accept input. It is a separate state machine with these phases:

| Phase | Meaning |
| --- | --- |
| `unallocated` | No execution reference exists yet. |
| `provisioning` | A workspace exists; the native agent has not started. |
| `starting` | Started, but not yet interactive/input-capable. |
| `awaiting_trust` | A recognized startup directory gate or an unresolved native-trust decision; authorization is checked separately. |
| `awaiting_manual` | Blocked on any other native menu; needs a user or an authorized decision. |
| `ready` | Interactive and input-capable. |
| `busy` | The native agent is currently working. |
| `missing` | The native target is confirmed absent. |
| `uncertain` | The target could not be read or classified; never treated as ready. |
| `stopped` | An explicit user control holds this executor. |
| `removed` | The participant was removed by the user. |

`created` and `started` only prove allocation. `started` is not `ready`, `ready`
is not "business is running", and none of them is user acceptance.

### Consequence for a business pause

A settled business pause fences business input and relays only. It must still
allow:

- first provisioning of a participant that has never started;
- rebuilding a participant whose execution disappeared;
- the restricted startup-directory-trust confirmation.

It must never automatically deliver a business prompt, including an initial
prompt provisioned but never delivered before the pause settled.

An explicit `interrupt` is different: it durably holds only the selected executor,
including one not allocated yet. Its peers may still be provisioned or repaired.
Explicit resume releases the applicable holds; a fresh send releases only its
selected executor. Owner revocation, pending user controls, removal and terminal
task states continue to fence native effects.

### Generation binding

Readiness is keyed to the execution generation, computed as
`executionRecovery ?? "initial"`. Whenever a participant's execution is rebuilt,
the generation changes and the new instance starts from clean readiness. A
retired instance's observation, receipt or pending decision can never describe
the replacement.

## Startup directory trust

Confirming that the native CLI may trust the task's authorized working directory
is long-term user authorization, not a business turn. It is handled by a
dedicated restricted route that:

- runs independently of Jev being enabled or disabled, and independently of the
  business pause;
- offers exactly one tool, which re-verifies the task, participant, execution
  identity, generation, real directory identity (including platform aliases such
  as `/var` → `/private/var`) and the exact native menu before writing a single
  key;
- is taken *before* the generic automatic-approval route, so an ordinary menu
  cannot pre-empt it.

When the exact authorized folder gate is recognized, the route confirms it
without the user sending "continue". No documentation or log should imply that a
user message is required to finish an authorized startup trust.

### Unknown effects freeze their generation

If a startup-trust write is attempted and its effect cannot be confirmed, that
execution generation is frozen:

- the same generation is never auto-replayed, across service restarts, screen
  `stateSeq` changes, recognition-version upgrades and Jev enablement;
- neither generic automatic approval nor business-input delivery can bypass the
  freeze, even when a later native snapshot appears idle;
- a definitely new generation (a rebuilt executor) is not governed by retired
  receipts, which stay on disk for audit.

An attempt that is provably not executed — a user control queued behind the model
call, or an owner whose authorization was revoked — is a veto of that attempt
only. It leaves no receipt, consumes no attempt budget, and does not disable the
restricted route for a later, legitimately authorized observation. Authorization
and identity are rechecked after asynchronous preflight and synchronously at the
transport's actual socket-write boundary. Native `agent.start` carries a lifecycle
admission guard to that same boundary.

Upgrade compatibility is conservative: legacy executing/uncertain automatic
approval decisions still freeze the same native identity even without a generation
field. Legacy directory-trust receipts are attributed to the retiring generation
before replacement without rewriting their historical outcomes. A ready-looking
native snapshot cannot erase an unresolved effect. Truncated or unreadable startup
screens without an established session are `unknown`, not inferred ready.

## Operator recovery path

1. Inspect `task_get`: the participant's `readiness` and `readinessReason` state
   the current lifecycle phase, separately from the task status and from
   `initialDelivery`.
2. A recognized, authorized `awaiting_trust` gate resolves itself when the
   configured startup decision engine is available; no business message is
   required. An unresolved prior effect is instead frozen, not automatically retried.
3. `awaiting_manual` needs a user or an authorized decision; it is not ready.
4. `missing` is repaired by background observation under the same participant
   identity. The repair does not deliver the old requirement.
5. A frozen generation is reported honestly and is never silently retried. A
   replacement execution starts a new generation.
6. To continue after a repair the user sends a fresh arrangement; that send is
   user control, not an automatic replay.

## Test contract

The behavior above is covered by black-box tests that use synthetic fixtures and
never touch a production database, native RPC or model network:

- `tests/app/agent-lifecycle-review.test.ts` — Jev on/off, first start and
  recovery, trust freeze across restart/`stateSeq`/Jev, queued-control and owner
  revocation vetoes, terminal replacement at the effect boundary;
- `tests/tasks/agent-lifecycle-review.test.ts` — scheduling-only pause permits
  provisioning but never the initial prompt, peer repair does not dispatch another
  participant's pending initial input, interruption before allocation prevents
  startup, named sends release only the selected executor's hold, queued controls
  veto initial/replacement launch without poisoning retry, and resume after repair
  never replays a historical initial prompt;
- `tests/tasks/readiness.test.ts` — stale-generation observations, unknown native
  effects despite later idle snapshots, legacy pause/trust migration and clean
  replacement generations;
- `tests/herdr/send-priority.test.ts` — real local socket tests for launch/trust
  admission after connection begins and before native writes; a provable trust
  veto leaves an identical-screen retry available;
- `tests/app/automatic-approvals.test.ts` — current and pre-upgrade
  executing/uncertain decisions freeze generic automatic approval.
