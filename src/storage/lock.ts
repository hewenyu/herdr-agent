import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { OperationError } from "../core/errors.js";
import { flockBinding } from "./native.js";

export interface StateLockStatus {
  state: "locked" | "unlocked" | "unknown";
  stateDir: string;
  path: string;
  /** Informational PID recorded by the holder, never permission to signal a process. */
  pid?: number;
  reason?: string;
}

function recordedPid(fd: number): number | undefined {
  try {
    const buffer = Buffer.alloc(32);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, length).toString("utf8").trim();
    if (!/^[1-9]\d{0,9}$/.test(value)) return;
    const pid = Number(value);
    return pid <= 2_147_483_647 ? pid : undefined;
  } catch {
    return;
  }
}

/** Check both protocols: an older process may own only the compatibility lock. */
export function inspectStateLock(stateDir: string): StateLockStatus {
  const primary = inspectLockFile(stateDir, "myrix.pid");
  const legacy = inspectLockFile(stateDir, "herdr-agent.pid");
  if (primary.state === "locked") return primary;
  if (legacy.state === "locked") return legacy;
  if (primary.state === "unknown") return primary;
  if (legacy.state === "unknown") return legacy;
  return primary;
}

/** Probe the existing inode without creating, truncating, removing or taking over state. */
function inspectLockFile(stateDir: string, filename: string): StateLockStatus {
  const directory = resolve(stateDir);
  const path = join(directory, filename);
  const base = { stateDir: directory, path };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ...base, state: "unlocked" }
      : { ...base, state: "unknown", reason: "状态锁无法只读打开；请检查权限和符号链接。" };
  }
  let locked = false;
  let binding: ReturnType<typeof flockBinding> | undefined;
  try {
    const held = fstatSync(fd);
    if (!held.isFile())
      return { ...base, state: "unknown", reason: "状态锁不是普通文件，未读取内容。" };
    binding = flockBinding();
    let busy = false;
    try {
      binding.flock(fd, binding.constants.LOCK_EX | binding.constants.LOCK_NB);
      locked = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
      busy = true;
    }
    const current = statSync(path);
    if (held.dev !== current.dev || held.ino !== current.ino)
      return { ...base, state: "unknown", reason: "检查期间状态锁已更换，请重新查询。" };
    return busy
      ? { ...base, state: "locked", pid: recordedPid(fd) }
      : { ...base, state: "unlocked" };
  } catch {
    return { ...base, state: "unknown", reason: "状态锁检查未完成或锁已变化，请重新查询。" };
  } finally {
    try {
      if (locked && binding) binding.flock(fd, binding.constants.LOCK_UN);
    } finally {
      closeSync(fd);
    }
  }
}

/** Hold the legacy lock first so older installations cannot start beside myrix. */
export function acquireLock(stateDir: string): { release(): void; path: string } {
  const legacy = acquireLockFile(stateDir, "herdr-agent.pid");
  let primary: ReturnType<typeof acquireLockFile>;
  try {
    primary = acquireLockFile(stateDir, "myrix.pid");
  } catch (error) {
    legacy.release();
    throw error;
  }
  return {
    path: primary.path,
    release() {
      try {
        primary.release();
      } finally {
        legacy.release();
      }
    },
  };
}

/** Same POSIX flock and inode protocol as the Go runtime; PID alone is not a lock. */
function acquireLockFile(stateDir: string, filename: string): { release(): void; path: string } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, filename);
  const binding = flockBinding();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    } catch {
      throw new OperationError("state_lock", "无法打开状态锁，请检查目录权限和符号链接。");
    }
    try {
      binding.flock(fd, binding.constants.LOCK_EX | binding.constants.LOCK_NB);
      const held = fstatSync(fd);
      const current = statSync(path);
      if (held.dev !== current.dev || held.ino !== current.ino) {
        closeSync(fd);
        continue;
      }
      fchmodSync(fd, 0o600);
      ftruncateSync(fd, 0);
      writeSync(fd, `${process.pid}\n`);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            const latest = statSync(path);
            if (latest.dev === held.dev && latest.ino === held.ino) unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          } finally {
            try {
              binding.flock(fd, binding.constants.LOCK_UN);
            } finally {
              closeSync(fd);
            }
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const pid = code === "EAGAIN" || code === "EWOULDBLOCK" ? recordedPid(fd) : undefined;
      closeSync(fd);
      if (code === "ENOENT") continue;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        throw new OperationError(
          "already_running",
          `已有 myrix 持有状态锁（${pid ? `记录 PID ${pid}，` : ""}状态目录：${resolve(stateDir)}）。请运行 myrix status --state-dir '${resolve(stateDir).replaceAll("'", "'\\''")}' 核对实例和停止方式。不会启动第二条飞书连接。`,
        );
      }
      throw new OperationError("state_lock", "无法取得本机状态锁，请检查目录权限。");
    }
  }
  throw new OperationError("state_lock", "状态锁正在变化，请稍后重试。");
}
