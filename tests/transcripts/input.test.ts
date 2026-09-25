import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRef } from "../../src/core/types.js";
import { readInitialInput } from "../../src/transcripts/input.js";

const marker = `HERDR_RECEIPT_${"c".repeat(32)}`;
const text = `任务正文\n${marker}\n\n本轮安排：\n具体安排`;
const ref: ExecutionRef = {
  paneId: "w1:p1",
  workspaceId: "w1",
  kind: "codex",
  cwd: "/code/project",
  sessionId: "native-id",
};
const meta = { type: "session_meta", payload: { id: ref.sessionId, cwd: ref.cwd } };
const input = {
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
};
async function read(rows: unknown[], target = ref, receipt = marker, suffix = "") {
  const directory = await mkdtemp(join(tmpdir(), "input-readback-"));
  try {
    const path = join(directory, "native-id.jsonl");
    await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join("") + suffix);
    return await readInitialInput({ path }, target, receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Codex readback proves exact user input with matching native session and cwd", async () => {
  assert.equal(await read([meta, input]), text);
  assert.equal(await read([meta, input], ref, marker, '{"partial":'), text);
  assert.equal(await read([input]), undefined);
  assert.equal(await read([input, meta]), undefined);
  assert.equal(await read([meta, input], { ...ref, sessionId: "other" }), undefined);
  assert.equal(await read([meta, input], { ...ref, cwd: "/other" }), undefined);
  assert.equal(await read([meta, input], ref, `HERDR_RECEIPT_${"d".repeat(32)}`), undefined);
  assert.equal(await read([meta, input, meta]), undefined);
  assert.equal(await read([meta, input, input]), undefined);
  assert.equal(await read([meta], ref, marker, JSON.stringify(input)), undefined);
  assert.equal(await read([meta], ref, marker, `malformed\n${JSON.stringify(input)}\n`), undefined);
  assert.equal(
    await read([meta, { ...input, payload: { ...input.payload, role: "assistant" } }]),
    undefined,
  );
});

test("Claude readback excludes sidechains, metadata and conflicting sessions", async () => {
  const target: ExecutionRef = { ...ref, kind: "claude" };
  const row = {
    type: "user",
    sessionId: target.sessionId,
    cwd: target.cwd,
    message: { content: text },
  };
  assert.equal(await read([row], target), text);
  assert.equal(await read([row], { ...target, sessionId: undefined }), text);
  assert.equal(await read([{ ...row, isSidechain: true }], target), undefined);
  assert.equal(await read([{ ...row, isMeta: true }], target), undefined);
  assert.equal(await read([{ ...row, cwd: "/other" }], target), undefined);
  assert.equal(await read([row, { type: "system", sessionId: "another" }], target), undefined);
});

test("native input remains recoverable after a session grows beyond 8 MiB", async () => {
  const history = Array.from({ length: 10 }, () => ({
    type: "event_msg",
    text: "x".repeat(1_048_576),
  }));
  assert.equal(await read([meta, ...history, input]), text);
  assert.equal(await read([meta, input, ...history, input]), undefined);
});
