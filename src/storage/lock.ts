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

/** Probe the existing inode without creating, truncating, removing or taking over state. */
export function inspectStateLock(stateDir: string): StateLockStatus {
  const directory = resolve(stateDir);
  const path = join(directory, "herdr-agent.pid");
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

/** Same POSIX flock and inode protocol as the Go runtime; PID alone is not a lock. */
export function acquireLock(stateDir: string): { release(): void; path: string } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "herdr-agent.pid");
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
          `已有 herdr-agent 持有状态锁（${pid ? `记录 PID ${pid}，` : ""}状态目录：${resolve(stateDir)}）。请运行 myrix status --state-dir '${resolve(stateDir).replaceAll("'", "'\\''")}' 核对实例和停止方式。不会启动第二条飞书连接。`,
        );
      }
      throw new OperationError("state_lock", "无法取得本机状态锁，请检查目录权限。");
    }
  }
  throw new OperationError("state_lock", "状态锁正在变化，请稍后重试。");
}
