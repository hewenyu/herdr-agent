import { OperationError } from "../core/errors.js";
import type { Store } from "../storage/store.js";
import { hash, ImportPlan, type SourceFile } from "./common.js";
import { importConversation, importMemory } from "./conversations.js";
import { importReceipts } from "./receipts.js";
import { backupSources, businessSource, readSources, rollbackInstructions } from "./sources.js";
import { importTasks } from "./tasks.js";

export { isLegacyReplay, legacyOperation } from "./receipts.js";
export interface MigrationReport {
  version: 1;
  state: "empty" | "planned" | "migrated" | "already_migrated";
  fingerprint: string;
  files: Array<{ name: string; size: number; sha256: string }>;
  counts: Record<string, number>;
  warnings: string[];
  backupDir?: string;
  rollback: string[];
}
const migrationKey = "go-json-v1";

function prepare(files: SourceFile[]): ImportPlan {
  const plan = new ImportPlan();
  for (const file of files.filter((entry) => entry.name === "tasks.json")) {
    if (file.data) importTasks(file.data, plan, file.modifiedAt);
  }
  for (const file of files.filter((entry) => entry.name.startsWith("conversations/")))
    importConversation(file, plan);
  for (const file of files.filter((entry) => entry.name.startsWith("memory/")))
    importMemory(file, plan);
  for (const file of files.filter(
    (entry) =>
      entry.data &&
      !entry.name.startsWith("conversations/") &&
      !entry.name.startsWith("memory/") &&
      entry.name !== "tasks.json",
  ))
    importReceipts(file, plan);
  for (const file of files.filter((entry) => entry.data)) {
    plan.add("legacy_sources", file.name, { sha256: file.sha256, data: file.data });
  }
  return plan;
}

/** Caller must hold the application lock and stop the Go process before applying. */
export async function migrateLegacy(
  stateDir: string,
  store: Store,
  options: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  if (!stateDir) throw new OperationError("migration_directory", "迁移必须指定状态目录。");
  const files = await readSources(stateDir);
  const business = files.filter((file) => businessSource(file.name));
  const fingerprint = hash(...business.map((file) => `${file.name}\0${file.sha256}`));
  const previous = store.get<MigrationReport>("migrations", migrationKey);
  if (previous) {
    if (previous.version !== 1 || previous.fingerprint !== fingerprint)
      throw new OperationError(
        "migration_source_changed",
        "旧状态在迁移后发生变化；请核对新旧服务和备份，不能重复覆盖导入。",
      );
    return { ...previous, state: "already_migrated" };
  }
  const plan = prepare(files);
  const records = plan.all();
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.namespace] = (counts[record.namespace] ?? 0) + 1;
    if (store.get(record.namespace, record.key) !== undefined)
      throw new OperationError(
        "migration_conflict",
        "数据库已有同标识记录；迁移不会覆盖新数据，请先核对来源。",
      );
  }
  const report: MigrationReport = {
    version: 1,
    state: business.length ? "planned" : "empty",
    fingerprint,
    files: files.map(({ name, bytes, sha256 }) => ({ name, size: bytes.length, sha256 })),
    counts,
    warnings: [...plan.warnings],
    rollback: rollbackInstructions,
  };
  if (options.dryRun || !business.length) return report;
  const backupDir = await backupSources(stateDir, files);
  // A snapshot must not silently race an old service still writing JSON.
  const current = await readSources(stateDir);
  if (
    hash(...current.map((file) => `${file.name}\0${file.sha256}`)) !==
    hash(...files.map((file) => `${file.name}\0${file.sha256}`))
  ) {
    throw new OperationError(
      "migration_source_changed",
      "备份期间旧状态发生变化；备份已保留，数据库未导入。",
    );
  }
  const completed: MigrationReport = { ...report, state: "migrated", backupDir };
  store.transaction(() => {
    for (const record of records) store.set(record.namespace, record.key, record.value);
    store.set("migrations", migrationKey, completed);
  });
  return completed;
}
