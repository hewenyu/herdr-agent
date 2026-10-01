# Codex startup and orchestration reply regression

## Observed release

The incident was reproduced against `v0.3.26` (`671f125`). The service and Feishu connection started successfully. The Node SQLite experimental warning was not the execution failure. An earlier `migration_source_changed` refusal preceded the successful service startup and is a separate migration safeguard; this fix does not disable it.

## Read-only runtime evidence

Codex 0.158.0 exposed this visible screen while herdr reported `agent_status: idle` and `interactive_ready: true`:

```text
  Update available · 0.158.0 → 0.159.1
  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version

  enter continue · esc skip
```

The startup recognizer expected the older `Press enter to continue` footer. A ready-looking transport status was therefore insufficient evidence that Codex had reached its composer. Task text must not be sent into this menu, especially with the package-install option selected.

The task's discussion plan ran its first participant before Codex. At inspection time, Claude was actively researching that first assignment and Codex had not received its initial prompt. Waiting for the first participant was expected; mistaking the update menu for a ready composer was not.

The same service log also recorded `pi.turn_failed` with `model_failed / not_executed` after a confirmed task creation. The checkpoint contained successful creation/query receipts and replies distinguishing created resources from undelivered participant instructions. Reply-evidence validation and its failure classification need to preserve those distinctions: a rejected reply does not undo a business write, and starting an executor is not proof that task instructions were delivered.

No live task data, native menu selection, installed CLI version, or production process was changed during diagnosis. Regression fixtures use synthetic task, participant, and resource identifiers rather than production state.

## Fix boundaries

- Recognize the observed `enter continue · esc skip` footer as a numbered startup menu, retaining the cursor, option parsing, and final-screen-boundary checks. A startup `idle` observation is normalized to `blocked`, and `AgentControl.send` refuses task text without emitting native keys. Existing sessions and truncated observations keep their existing handling.
- Reuse the existing semantic approval path. This patch does **not** automatically update Codex, skip updates, change persistent preferences, or broaden directory-trust authority. Selecting `Skip` requires navigation/readback before confirmation when the cursor is on `Update now`.
- A refused read-only lookup is not an outstanding business write. A later successful lookup may support an accurate reply; unresolved write refusals still veto completion claims.
- At both engine and session boundaries, a rejected answer after a confirmed write is classified `unknown`, not `not_executed`. A refusal with no successful write remains `not_executed`.
- Pending provisioning clauses no longer borrow completion wording from local task registration. Read-backed, explicitly scoped process-start reports are supported by participant `started` facts, not by prompt-delivery facts. Unsupported task IDs, groups, deliveries, new-write claims, and unresolved effects remain guarded.

The installed tag is unchanged by this source patch. Deployment requires a release containing the fix; an already-visible update menu still needs an authorized choice.
