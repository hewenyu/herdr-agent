import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_RESULT_MESSAGE_UNITS,
  CHILD_RESULT_TAIL_UNITS,
  type ChildResultSnapshotInput,
  childResultDiagnosticRequired,
  childResultSnapshot,
} from "./child-result.js";

type Snapshot = {
  pid: number;
  status: number | null;
  signal: string | null;
  error: Record<string, unknown> | null;
  stdout: Record<string, unknown>;
  stderr: Record<string, unknown>;
};
const parse = (message: string): Snapshot => JSON.parse(message) as Snapshot;

/** Pure field stand-ins: these contracts observe no child process and no timing. */
function observed(extra: Partial<ChildResultSnapshotInput> = {}): ChildResultSnapshotInput {
  const fields: ChildResultSnapshotInput = {
    pid: 4321,
    status: 0,
    signal: null,
    error: undefined,
    stdout: "",
    stderr: "",
  };
  return { ...fields, ...extra };
}

test("a timeout snapshot keeps the error beside non-empty streams", () => {
  const shape = observed({
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
    stdout: "starting\n",
    stderr: "slow\n",
  });
  const fields = parse(childResultSnapshot(shape));
  assert.deepEqual(fields.error, {
    name: "Error",
    code: "ETIMEDOUT",
    message: "spawnSync ETIMEDOUT",
    messageTruncated: false,
  });
  assert.deepEqual(
    [fields.pid, fields.status, fields.signal, fields.stdout.tail, fields.stderr.tail],
    [4321, null, "SIGTERM", "starting\n", "slow\n"],
  );
  const failed = parse(childResultSnapshot(observed({ stdout: null, stderr: "" })));
  assert.deepEqual(
    [failed.stdout, failed.stderr],
    [{ state: "missing" }, { state: "empty", codeUnits: 0, truncated: false, tail: "" }],
  );
});

test("long unicode and control output is truncated into one parseable line within the cap", () => {
  const unit = '\u0000\u001f\n\r\t\\"\ud800😀';
  const text = unit.repeat(200);
  const message = childResultSnapshot(observed({ stdout: text, stderr: text, pid: -1 }));
  const stdout = parse(message).stdout;
  assert.equal(stdout.codeUnits, text.length);
  assert.equal(stdout.truncated, true);
  assert.equal(stdout.tail, text.slice(-CHILD_RESULT_TAIL_UNITS));
  assert.equal(message.includes("\n"), false, "the snapshot must stay one line");
  // Worst case the cap admits: every retained unit escapes to six JSON characters.
  const nulls = "\u0000".repeat(600);
  const error = Object.assign(new Error(nulls), { name: nulls, code: nulls });
  const loud = childResultSnapshot(observed({ error, stdout: nulls, stderr: nulls }));
  assert.equal(CHILD_RESULT_TAIL_UNITS, 512);
  assert.equal(CHILD_RESULT_MESSAGE_UNITS, 8192);
  assert.ok(loud.length <= CHILD_RESULT_MESSAGE_UNITS, `${loud.length} <= cap`);
});

test("Unicode line controls are escaped without changing the observed text", () => {
  const text = "a\u0085b\u2028c\u2029d";
  const message = childResultSnapshot(observed({ stdout: text, stderr: "\r\n" }));
  assert.doesNotMatch(message, /[\r\n\u0085\u2028\u2029]/);
  assert.equal(parse(message).stdout.tail, text);
});

test("a signal-only failure is diagnosable without leaking a stack or spawnargs", () => {
  const killed = parse(childResultSnapshot(observed({ status: null, signal: "SIGKILL" })));
  assert.equal(childResultDiagnosticRequired(observed({ signal: "SIGKILL" })), true);
  assert.equal(killed.signal, "SIGKILL", "a signal alone must name the failure");
  const error = Object.assign(new Error("x".repeat(500)), { code: "ENOENT", stack: "SECRET" });
  const message = childResultSnapshot(observed({ error, stdout: "out" }));
  assert.equal(error.message.length, 500, "the observed error must not be modified");
  const rendered = parse(message).error ?? {};
  assert.deepEqual([rendered.messageTruncated, rendered.message], [true, "x".repeat(128)]);
  assert.deepEqual([message.includes("SECRET"), message.includes("spawnargs")], [false, false]);
});

test("snapshotting is read-only, and a clean run needs no diagnostic", () => {
  const clean = {
    ...observed(),
    get stdout(): string {
      throw new Error("successful results must not read formatting-only fields");
    },
  };
  assert.equal(childResultDiagnosticRequired(clean), false);
  const shape = observed({ status: null, error: new Error("boom"), stdout: "out" });
  childResultSnapshot(shape);
  assert.deepEqual([shape.error?.message, shape.stdout], ["boom", "out"]);
});

test("a falsey error is still an error, while a truthy one is reported", () => {
  for (const value of [undefined, null, 0, "", false] as unknown[]) {
    const probe = observed({ error: value as ChildResultSnapshotInput["error"] });
    assert.equal(childResultDiagnosticRequired(probe), value !== undefined, String(value));
    if (value !== undefined) assert.notEqual(parse(childResultSnapshot(probe)).error, null);
  }
});
