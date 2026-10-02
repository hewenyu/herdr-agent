import assert from "node:assert/strict";
import test from "node:test";
import { checkModuleBoundaries, moduleDependencies } from "../../scripts/module-boundaries.js";

function violations(path: string, text: string): string[] {
  return checkModuleBoundaries(new Map([[path, text]]));
}

test("dependency parsing covers static, re-export, dynamic, require and type syntax", () => {
  const dependencies = moduleDependencies(
    "src/tasks/example.ts",
    [
      'import type { A } from "../app/a.js";',
      'export { type B } from "../app/b.js";',
      'export * from "../app/c.js";',
      'const dynamic = import("../app/d.js");',
      'const required = require("../app/e.js");',
      'type F = import("../app/f.js").F;',
      'import G = require("../app/g.js");',
      'import { type H, value } from "../app/h.js";',
      'import "../app/i.js";',
      'import { type J } from "../app/j.js";',
      '// import "../app/not-an-import.js";',
      "const example = 'import(\"../app/also-not-an-import.js\")';",
    ].join("\n"),
  );
  assert.deepEqual(
    dependencies.map((dependency) => dependency.line),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    dependencies.map((dependency) => dependency.typeOnly),
    [true, true, false, false, false, true, false, false, false, true],
  );
});

test("lower layers cannot import application implementations even as types or through re-exports", () => {
  for (const layer of ["tasks", "orchestration", "core", "storage", "runtime"]) {
    for (const text of [
      'import type { A } from "../app/task-orchestrator.js";',
      'export * from "../app/task-orchestrator.js";',
      'const value = import("../app/task-orchestrator.js");',
      'const value = require("../app/task-orchestrator.js");',
      'type Value = import("../app/task-orchestrator.js").A;',
      'import A from "./nested/../../app/task-orchestrator.js";',
    ])
      assert.equal(violations(`src/${layer}/example.ts`, text).length, 1, `${layer}: ${text}`);
  }
});

test("selected server layer boundaries permit contracts without forcing unrelated redesign", () => {
  for (const [path, text] of [
    ["src/core/inbox.ts", 'import type { ActorContext } from "./types.js";'],
    ["src/storage/store.ts", 'import { fail } from "../core/errors.js";'],
    ["src/runtime/engine.ts", 'import type { AppConfig } from "../config/types.js";'],
    ["src/tasks/restart.ts", 'import type { Dispatch } from "../orchestration/contracts.js";'],
    ["src/app/task-ingress.ts", 'export { taskIngress } from "../tasks/ingress.js";'],
    ["src/core/ids.ts", 'import { createHash } from "node:crypto";'],
  ] as const)
    assert.deepEqual(violations(path, text), []);
  assert.equal(violations("src/core/example.ts", 'import "../storage/store.js";').length, 1);
  assert.equal(violations("src/storage/example.ts", 'import "../tasks/service.js";').length, 1);
  assert.equal(
    violations("src/runtime/example.ts", 'import "../orchestration/runner.js";').length,
    1,
  );
});

test("browser imports are local or explicitly type-only shared contracts", () => {
  const path = "src/web/client/example.ts";
  assert.deepEqual(
    violations(
      path,
      [
        'import { button } from "./dom.js";',
        'import type { WebState } from "../contracts.js";',
        'import { type Project } from "../../core/types.js";',
      ].join("\n"),
    ),
    [],
  );
  for (const text of [
    'import { WebState } from "../contracts.js";',
    'import { type WebState, server } from "../contracts.js";',
    'import type { Store } from "../../storage/store.js";',
    'export * from "../server.js";',
    'const value = import("node:fs");',
    'import { readFile } from "node:fs/promises";',
    'import "external-server-package";',
    "const value = import(modulePath);",
    "const value = require(modulePath);",
  ])
    assert.equal(violations(path, text).length, 1, text);
  assert.deepEqual(
    violations("src/web/contracts.ts", 'import type { Task } from "../core/types.js";'),
    [],
  );
  assert.equal(
    violations("src/web/contracts.ts", 'export * from "../app/application.js";').length,
    1,
  );
});

test("diagnostics retain source path and line for CI review", () => {
  assert.match(
    violations("src/tasks/example.ts", '\nimport type { A } from "../app/example.js";')[0] ?? "",
    /^src\/tasks\/example.ts:2: ..\/app\/example.js: tasks must use domain contracts/,
  );
});
