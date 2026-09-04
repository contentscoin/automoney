import fs from "node:fs";
import path from "node:path";

/**
 * 스페이스별 크로스 프로세스 락 (blogautomcp chatgpt-profile-lock.ts 를 스페이스 단위로 일반화).
 * 파일을 "wx" 로 생성해 원자적으로 획득하고, 소유 pid 가 죽어 있으면 stale 로 간주해 회수한다.
 */
export interface LockHandle {
  release(): void;
  ownerId: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(lockPath: string, purpose: string, opts: { waitMs?: number } = {}): LockHandle {
  const ownerId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + (opts.waitMs ?? 0);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ ownerId, pid: process.pid, purpose, acquiredAt: Date.now() }), { flag: "wx" });
      return {
        ownerId,
        release() {
          try {
            const cur = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { ownerId?: string };
            if (cur.ownerId === ownerId) fs.unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const cur = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number; acquiredAt?: number };
        stale = !cur.pid || !pidAlive(cur.pid) || (cur.acquiredAt !== undefined && Date.now() - cur.acquiredAt > 6 * 3600_000);
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* race */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        const err = new Error("SPACE_LOCKED") as Error & { code: string };
        err.code = "SPACE_LOCKED";
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
