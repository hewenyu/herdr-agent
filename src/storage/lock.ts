import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { OperationError } from "../core/errors.js";
import { flockBinding } from "./native.js";

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
      closeSync(fd);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        throw new OperationError(
          "already_running",
          "已有 herdr-agent 持有状态锁，请先停止该实例。不会启动第二条飞书连接。",
        );
      }
      throw new OperationError("state_lock", "无法取得本机状态锁，请检查目录权限。");
    }
  }
  throw new OperationError("state_lock", "状态锁正在变化，请稍后重试。");
}
