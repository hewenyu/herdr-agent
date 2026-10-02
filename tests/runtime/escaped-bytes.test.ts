import assert from "node:assert/strict";
import test from "node:test";
import {
  escapedBytes as escapedBytesCanonical,
  escapedPrefix,
} from "../../src/runtime/escaped-bytes.js";
import { parseJson, plainObject, serialize } from "../../src/runtime/json.js";
import { serialize as modelSerialize } from "../../src/runtime/model-context.js";
import { escapedBytes as escapedBytesRecovery } from "../../src/runtime/recovery-envelope.js";
import {
  escapedBytes as escapedBytesFacts,
  escapedPrefix as factEscapedPrefix,
} from "../../src/runtime/result-projection-facts.js";
import {
  escapedBytes as escapedBytesPages,
  escapedSlice,
} from "../../src/runtime/result-projection-pages.js";

/**
 * Direct tests for the extracted escape/JSON helpers. `escapedBytes` and the
 * code-point prefix loop were byte-identical copies in three runtime modules;
 * these assertions pin the escaping classes, the surrogate-pair boundary and
 * the byte budgets, and prove every former copy still agrees exactly.
 */

/** Text spanning every JSON escaping class plus multibyte and astral code points. */
const CORPUS = [
  "",
  "plain ascii",
  'quote " backslash \\',
  "\n\t\r\b\f",
  "\u0000\u0001\u001f\u007f",
  "é中",
  "𝄞",
  "😀",
  "a𝄞b",
  "\ud800",
  '😀\u0000"\\é',
];

test("escapedBytes measures one JSON string field exactly", () => {
  assert.equal(escapedBytesCanonical(""), 0);
  assert.equal(escapedBytesCanonical("abc"), 3);
  assert.equal(escapedBytesCanonical('"'), 2, "a quote escapes to two bytes");
  assert.equal(escapedBytesCanonical("\\"), 2, "a backslash escapes to two bytes");
  assert.equal(escapedBytesCanonical("\n"), 2);
  assert.equal(escapedBytesCanonical("\u0000"), 6, "a control escapes to six bytes");
  assert.equal(escapedBytesCanonical("\u001f"), 6);
  assert.equal(escapedBytesCanonical("\u007f"), 1, "DEL is not escaped by JSON.stringify");
  assert.equal(escapedBytesCanonical("é"), 2, "multibyte text keeps its UTF-8 size");
  assert.equal(escapedBytesCanonical("𝄞"), 4, "a well-paired astral char stays four UTF-8 bytes");
  assert.equal(escapedBytesCanonical("😀"), 4);
  assert.equal(escapedBytesCanonical("\ud800"), 6, "a lone surrogate is well-formed-escaped");
  assert.equal(
    escapedBytesCanonical(undefined as unknown as string),
    2,
    "a missing value keeps the historical JSON null contract",
  );
});

test("every former escapedBytes copy reports identical bytes", () => {
  for (const text of CORPUS) {
    const expected = escapedBytesCanonical(text);
    assert.equal(escapedBytesPages(text), expected, `pages differs for ${JSON.stringify(text)}`);
    assert.equal(escapedBytesFacts(text), expected, `facts differs for ${JSON.stringify(text)}`);
    assert.equal(
      escapedBytesRecovery(text),
      expected,
      `recovery differs for ${JSON.stringify(text)}`,
    );
  }
});

test("escapedPrefix never splits a surrogate pair", () => {
  assert.equal(escapedPrefix("𝄞", 3), "");
  assert.equal(escapedPrefix("𝄞", 4), "𝄞");
  assert.equal(escapedPrefix("𝄞𝄞", 4), "𝄞");
  assert.equal(escapedPrefix("a𝄞", 5), "a𝄞");
  assert.equal(escapedPrefix("a𝄞", 4), "a");
  assert.equal(escapedPrefix("😀", 3), "");
  assert.equal(escapedPrefix("a😀b", 5), "a😀");
});

test("escapedPrefix cuts by escaped bytes, not characters", () => {
  assert.equal(escapedPrefix('"""', 2), '"');
  assert.equal(escapedPrefix('"""', 3), '"');
  assert.equal(escapedPrefix('"""', 4), '""');
  assert.equal(escapedPrefix("\u0000\u0000", 6), "\u0000");
  assert.equal(escapedPrefix("\u0000\u0000", 5), "");
  assert.equal(escapedPrefix("abc", 1), "a");
  assert.equal(escapedPrefix("abc", 2), "ab");
  assert.equal(escapedPrefix("abc", 3), "abc");
});

test("escapedPrefix honours empty, zero and small budgets", () => {
  assert.equal(escapedPrefix("abc", 0), "");
  assert.equal(escapedPrefix("abc", -5), "");
  assert.equal(escapedPrefix("", 0), "");
  assert.equal(escapedPrefix("", 100), "");
  assert.equal(escapedPrefix("abc", 100), "abc");
});

test("escapedPrefix output is always a prefix that re-serializes inside the budget", () => {
  for (const text of CORPUS) {
    for (const budget of [0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 64]) {
      const slice = escapedPrefix(text, budget);
      assert.ok(text.startsWith(slice), `${JSON.stringify(text)} is not a prefix of the input`);
      assert.ok(
        escapedBytesCanonical(slice) <= budget,
        `slice of ${JSON.stringify(text)} at ${budget} bytes escaped to ${escapedBytesCanonical(slice)}`,
      );
    }
  }
});

test("page escapedSlice and fact escapedPrefix agree exactly", () => {
  for (const text of CORPUS) {
    for (const budget of [0, 1, 5, 6, 12, 13, 64]) {
      assert.equal(escapedSlice(text, budget), factEscapedPrefix(text, budget));
      assert.equal(escapedSlice(text, budget), escapedPrefix(text, budget));
    }
  }
});

test("serialization retains null fallbacks and fails closed on unrepresentable values", () => {
  assert.equal(modelSerialize, serialize);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const throwing = {
    toJSON() {
      throw new Error("cannot serialize");
    },
  };
  for (const value of [null, undefined, Symbol("absent"), () => {}]) {
    assert.equal(serialize(value), "null");
    assert.equal(escapedBytesCanonical(value as unknown as string), 2);
  }
  for (const value of [cycle, 1n, throwing]) {
    assert.equal(serialize(value), undefined);
    assert.equal(escapedBytesCanonical(value as unknown as string), Number.MAX_SAFE_INTEGER);
  }
});

test("parseJson returns parsed values and undefined for invalid text", () => {
  assert.deepEqual(parseJson('{"a":1,"b":[true,null]}'), { a: 1, b: [true, null] });
  assert.deepEqual(parseJson("[1,2]"), [1, 2]);
  assert.equal(parseJson("null"), null);
  assert.equal(parseJson('"text"'), "text");
  assert.equal(parseJson("42"), 42);
  assert.equal(parseJson("false"), false);
  assert.equal(parseJson(""), undefined);
  assert.equal(parseJson("{"), undefined);
  assert.equal(parseJson("not json"), undefined);
  assert.equal(parseJson("undefined"), undefined);
  assert.equal(parseJson("NaN"), undefined);
});

test("plainObject accepts only non-null, non-array objects", () => {
  const record = { a: 1 };
  assert.equal(plainObject(record), record);
  assert.deepEqual(plainObject({}), {});
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  assert.equal(plainObject(nullPrototype), nullPrototype);
  assert.equal(plainObject([]), undefined);
  assert.equal(plainObject(null), undefined);
  assert.equal(plainObject(undefined), undefined);
  assert.equal(plainObject("x"), undefined);
  assert.equal(plainObject(1), undefined);
  assert.equal(plainObject(true), undefined);
  assert.equal(
    plainObject(() => {}),
    undefined,
  );
});
