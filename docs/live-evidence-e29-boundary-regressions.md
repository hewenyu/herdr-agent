# E29: session and dissolved-group boundary regressions

Date: 2026-09-19 (Asia/Shanghai).

The local regression suite covers two routing boundaries found during the current
audit:

- Task IDs include the pi `sessionId`, so two sessions can reuse a request ID
  while creating independent projects. A pre-change task key is reused only for
  a retry from its persisted session.
- A dissolved task group remains available for historical inspection, but late
  messages and card callbacks are ignored at ingress and again before inbox
  execution. They cannot create a main pi session or consume an approval nonce.

The legacy bridge also filters its `/ls` picker to managed Claude/Codex agents
and rejects malformed stored routes. `npm run check` passed 463/463 tests,
including the scheduling, group-event and legacy regressions.

This is local automated evidence. It does not prove real Feishu user ingress,
external model decisions, herdr resources, or a complete production lifecycle.
