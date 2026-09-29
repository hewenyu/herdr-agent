import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export interface FileLog {
  /** Available only while writes to this file are succeeding. */
  readonly path: string | undefined;
  write(line: string): void;
  close(): void;
}

/** One service owns this sink under the state lock; failures must never replay business effects. */
export function openFileLog(
  stateDir: string,
  fallback: (line: string) => void,
  options: { maxBytes?: number; backups?: number } = {},
): FileLog {
  const directory = join(stateDir, "log");
  const path = join(directory, "myrix.log");
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const backups = options.backups ?? 5;
  let fd: number | undefined;
  let size = 0;
  let closed = false;
  let failed = false;
  // Console failure (for example a closed pipe) is also independent from task execution.
  const consoleWrite = (line: string) => {
    try {
      fallback(line);
    } catch {
      /* No further diagnostic sink is available. */
    }
  };
  const close = () => {
    const descriptor = fd;
    fd = undefined;
    if (descriptor !== undefined) closeSync(descriptor);
  };
  const fail = (error: unknown) => {
    try {
      close();
    } catch {
      /* Preserve the original write/open failure. */
    }
    if (failed) return;
    failed = true;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    consoleWrite(
      `日志文件不可用，已切换到控制台（${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "log_io"}）；请检查状态目录的 log 子目录与可用磁盘空间。`,
    );
  };
  const open = () => {
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe log file");
    fchmodSync(fd, 0o600);
    size = stat.size;
  };
  const remove = (target: string) => {
    try {
      unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const rotate = () => {
    close();
    remove(`${path}.${backups}`);
    for (let index = backups - 1; index >= 1; index--) {
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    renameSync(path, `${path}.1`);
    open();
  };
  try {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(backups) ||
      backups < 1
    )
      throw new Error("Invalid log limits");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error("Unsafe log directory");
    open();
  } catch (error) {
    fail(error);
  }
  return {
    get path() {
      return fd === undefined ? undefined : path;
    },
    write(line) {
      if (closed || failed || fd === undefined) {
        consoleWrite(line);
        return;
      }
      const buffer = Buffer.from(`${line}\n`);
      try {
        // Keep records intact, including the rare single record larger than maxBytes.
        if (size > 0 && size + buffer.length > maxBytes) rotate();
        if (fd === undefined) throw new Error("Log file is closed");
        let offset = 0;
        while (offset < buffer.length) {
          const written = writeSync(fd, buffer, offset, buffer.length - offset);
          if (written <= 0) throw new Error("Log write made no progress");
          offset += written;
          size += written;
        }
      } catch (error) {
        fail(error);
        consoleWrite(line);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        close();
      } catch (error) {
        fail(error);
      }
    },
  };
}
