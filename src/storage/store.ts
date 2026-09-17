import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OperationError } from "../core/errors.js";

/** Small transactional record store. Namespaces separate durable business facts. */
export class Store {
  private readonly database: DatabaseSync;
  private inTransaction = false;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // SQLite inherits the database mode for WAL/SHM; secure it before opening.
      if (path !== ":memory:") {
        const fd = openSync(path, "a", 0o600);
        closeSync(fd);
        chmodSync(path, 0o600);
        for (const suffix of ["-wal", "-shm"]) {
          try {
            chmodSync(`${path}${suffix}`, 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      this.database = new DatabaseSync(path);
      this.database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
      this.database.exec(`CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(namespace, key)
      ); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      const version = this.database
        .prepare("SELECT value FROM metadata WHERE key='schema_version'")
        .get() as { value: string } | undefined;
      if (version && version.value !== "1") {
        this.database.close();
        throw new Error("unsupported database version");
      }
      this.database.prepare("INSERT OR IGNORE INTO metadata VALUES('schema_version', '1')").run();
      if (path !== ":memory:") chmodSync(path, 0o600);
    } catch (cause) {
      throw new OperationError(
        "state_unavailable",
        "持久状态无法打开；请保留原文件并运行诊断。",
        "not_executed",
        { cause },
      );
    }
  }

  get<T>(namespace: string, key: string): T | undefined {
    const row = this.database
      .prepare("SELECT value FROM records WHERE namespace=? AND key=?")
      .get(namespace, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  entries<T>(namespace: string): Array<[string, T]> {
    const rows = this.database
      .prepare("SELECT key,value FROM records WHERE namespace=? ORDER BY key")
      .all(namespace) as Array<{ key: string; value: string }>;
    return rows.map((row) => [row.key, JSON.parse(row.value) as T]);
  }

  list<T>(namespace: string): T[] {
    return this.entries<T>(namespace).map(([, value]) => value);
  }

  set<T>(namespace: string, key: string, value: T): void {
    this.database
      .prepare(`INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(namespace, key, JSON.stringify(value), new Date().toISOString());
  }

  delete(namespace: string, key: string): void {
    this.database.prepare("DELETE FROM records WHERE namespace=? AND key=?").run(namespace, key);
  }

  transaction<T>(run: () => T): T {
    if (this.inTransaction) return run();
    this.database.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = run();
      if (result instanceof Promise) throw new Error("Database transaction must be synchronous");
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.database.close();
  }
}
